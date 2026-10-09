# ADR-0030: Launch the person's own agent over ACP, in a tab

- **Status:** Accepted
- **Date:** 2026-10-08
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The owner's question of 2026-10-08, whether Nendo can host an agent with ACP
  and AG-UI, launched from the Agent page as a new tab when the access level allows it. The
  Agent Client Protocol specification at protocol version 1 (`initialize`, `session/new`
  with `mcpServers`, `session/update`, `session/request_permission`, `session/cancel`).
  GitHub Copilot CLI starts an ACP agent on stdio with `--acp`, and Gemini CLI with
  `--experimental-acp` (0.29) or `--acp` (later); Claude Code and Codex speak it through
  published adapters, and OpenCode with `opencode acp`. The Copilot CLI live check of
  2026-10-08, which drove a real agent against a Nendo file over HTTP MCP. Accepted on the
  owner's standing pre-acceptance of ADR changes (2026-09-24). Built the same day as W-195;
  see Delivery
- **Amends:** ADR-0014 (the Workbench gains a conversation tab; the rest stands)
- **Depends on:** ADR-0002 process model and bridge, ADR-0009 access levels and the MCP
  boundary, ADR-0014 no model client in the host
- **Related design:** [Agent surface](../architecture.md#agent-surface),
  [Mica direction](../design/mica-direction.md)

## Context

[ADR-0014](0014-drop-embedded-agent-mcp-is-the-agent-surface.md) dropped the embedded
agent. Its reasons were concrete: no model-provider dependency, no custody of model
credentials, one authority path for change, and a preference for the client the person
already has. Its cost was also concrete: a person with no MCP client has no agent, and
nothing in the product shows the agent story on its own. Today a person has to open a
terminal, register the file's address with a client, and work beside Nendo rather than in
it.

Since that decision, the Agent Client Protocol (ACP) has become the common way for an
application to run a coding agent it does not own. The application starts the agent
program as a child process and talks JSON-RPC over its stdin and stdout. The agent program
brings its own model, its own sign-in and its own billing. When the application opens a
session, it names the MCP servers the agent should use. Editors use this to put Claude
Code, Codex, Gemini CLI and Copilot CLI in a pane without embedding any of them.

That removes the main costs ADR-0014 recorded. Nendo can start the agent the person has
already installed and signed in to, hand it the open file's MCP address, and show the
conversation in a tab. The host gains no model client and holds no credential, and every
change still crosses the MCP boundary.

AG-UI is a different protocol. It connects a hosted agent backend to a web front end,
usually over HTTP. It does not start a local program, and it does not name MCP servers.

## Decision drivers

1. Keep ADR-0014's properties: no model client in the host, no provider dependency, no
   credential custody, one authority path.
2. Give a person who has an agent installed a way to use it from inside Nendo, with no
   terminal and no registration step.
3. The access level the person chose for the file stays the only grant. A tab never
   raises it.
4. Say plainly what Nendo cannot confine.
5. One protocol to maintain, not a protocol and a translation layer.

## Options considered

### ACP: start the person's own agent program — selected

The Desktop host is the ACP client. It starts an installed agent program on stdio, opens
a session whose only named MCP server is this file's address, and forwards the
conversation to a tab. The agent program keeps its own model and sign-in.

### AG-UI between the host and the tab

Use AG-UI as the stream between the host and the Workbench, with ACP behind it. ACP
already delivers typed events for message text, tool calls, plans and permission requests,
so AG-UI would only rename them. It is a second contract for the same events, which
ADR-0014 rejected.

### AG-UI to a hosted agent

Connect the tab to an agent backend over AG-UI. That agent runs somewhere else, so the
host would need the network and somebody's credentials. This is the embedded agent
ADR-0014 dropped, reached over a wire.

### An in-process model client

ADR-0014's first rejected option. Nothing has changed its costs.

### Keep the external client only

The current state. It works, and it leaves the costs ADR-0014 recorded in place.

## Decision

**The Agent page may launch the person's own agent program over ACP, and the conversation
opens in a new tab.** The host stays an ACP client. It contains no model client, carries no
provider dependency and holds no credential.

### What may be launched

- An agent program already installed on this computer that speaks ACP on stdio. The host
  offers the ones it finds on `PATH` from a short list it knows (for example
  `copilot --acp` and `gemini --acp`, and the Claude Code and Codex ACP adapters), plus one
  command line the person enters. The person's choice is kept on this device, never in the
  file.
- The host never downloads, installs or updates an agent, and it does not read the ACP
  registry, so it still needs no network of its own. It may say what installs one: the
  page shows the command for a person to run in a terminal.

### When Launch is offered

- Launch is enabled when the file's access level is **Inspect or higher** and the agent
  listener is running. At Off, read-only or during recovery, the Agent page says why it is
  not offered.
- The tab shows the current access level and links to the Agent page. It has no control
  that changes the level.
- The access level is enforced where it already is, at the MCP boundary. The launched agent
  is one more MCP client, at the same level and under the same lease rules as any other.
  The tab's gating is a convenience, not the protection.

### What the host tells the agent

- `initialize` declares no file-system and no terminal client capability, so the agent
  cannot use Nendo to read or write files or run commands.
- `session/new` names exactly one MCP server: this file's loopback address, as an `http`
  server. An agent that does not declare `mcpCapabilities.http` is refused by name, before
  the session opens. The host has no stdio MCP server and does not add one for this.
- The session's working directory is a new empty folder that the host creates for it under
  this device's Nendo state and removes when the session ends. It is never the folder that
  holds the `.nendo` file.
- When the agent offers sign-in methods, the tab names them and the host may call
  `authenticate` with the one the person picks. The agent program performs the sign-in. No
  secret passes through Nendo.

### The tab

- The conversation is a new kind of tab in the window's tab strip. Like every tab, it
  belongs to the window, is never written to the file, and ends with the file.
- It shows the agent's message text, its tool calls with their kind and status, its plan,
  and its permission requests. The person types a prompt, and **Stop** sends
  `session/cancel`.
- Agent text is untrusted. It is rendered as text and safe Markdown. No HTML, no script and
  no automatic navigation.
- A permission request is shown to the person with the agent's own options. The host never
  answers one by itself and never chooses an *always* option on the person's behalf.
- A proposal the agent validates appears on the Agent page as it does today, and is
  reviewed there. The tab links to it. Below Unattended, the person still accepts it there.
- The transcript lives in the host's memory for the tab's lifetime. It is not kept in the
  file or on the device.

### Lifetime

- The agent program runs in a Job Object that ends it when the host process ends.
- Closing the tab, closing, switching or replacing the file, recovery, and lowering the
  level to Off end the session and the process. A level change between Inspect and
  Unattended does not end it: the agent's next MCP call meets the new level.
- One launched agent per file window at a time.

### What Nendo cannot confine

The agent program is the same program the person would run in a terminal, with the same
abilities. Many agent programs have their own shell, file and web tools, and run them
without asking. ACP lets an agent ask permission; it does not require it. Nendo gives the
agent no ability it did not already have: no file-system or terminal capability, an empty
working directory, and only the MCP address at the person's level. It does not sandbox the
program. The axiom that agents never receive raw SQL or filesystem authority holds for what
Nendo grants. It is not a claim about what the person's own agent program can do on this
computer. The Agent page and the tab say this in one sentence before the first launch.

### What does not change

ADR-0009's boundary, levels, leases and change-set gate. ADR-0014's decisions that the
host has no model client, no provider credentials and no model configuration, and that
AG-UI is not adopted. The external client path: a person may still connect any MCP client
from a terminal, and the registration commands stay on the Agent page.

## Evidence and validation obligations

Built in slices, each with its own Work item and acceptance criteria:

1. **ACP client in the Desktop host.** Start, `initialize`, `session/new`, `session/prompt`,
   `session/update`, `session/request_permission`, `session/cancel` and process end,
   driven by a fake ACP agent under `tests/`. Assert the declared client capabilities are
   all off, that the one MCP server named is this file's address, that the working
   directory is empty and is not the file's folder, that an agent without HTTP MCP is
   refused by name, and that the process ends when the file closes. Falsify each.
2. **The bridge.** The host-to-Workbench events and requests the tab needs, as an ADR-0002
   amendment with the bridge's version rule applied.
3. **The tab and Launch.** Mica direction, both themes. Launch is offered at Inspect and
   above and not at Off, read-only or recovery, measured in the Workbench lane. Untrusted
   agent text renders no HTML. A design canvas first.
4. **Finding installed agents and signing in.** The known list on `PATH`, the person's
   command line, and `authenticate` with an agent-offered method.
5. **A live check with a real agent.** Copilot CLI with `--acp` launched from the Agent
   page builds a small application in a test file. Recorded as agent-observed, with the
   exact agent version. It is not an automated pass.

Documentation obligations: the architecture's agent surface, the MCP contract's client
section, the Workbench help and the site's agents guide each describe the launched agent
when it ships, and not before.

## Delivery, 2026-10-08 (W-195)

The owner asked for the build after reading the decision. The pieces are listed under
*Launched agents* in [the architecture](../architecture.md#where-things-live).

How each obligation was met:

1. **The ACP client.** The Desktop suite runs `DesktopLaunchedAgentTests` against a
   stand-in agent, `tests/Nendo.Desktop.Tests/TestFixtures/fake-acp-agent.mjs`, which
   records what it was told. The tests measure:
   - every client capability is off;
   - exactly one MCP server is named, and it is this file's address;
   - the working folder is new and empty, and is not the file's folder;
   - an agent without HTTP MCP, or on another protocol version, is refused by name;
   - a permission request waits for the person;
   - Stop cancels the turn;
   - another level keeps the agent, Off ends it, and a moved address ends it with the
     new address named;
   - closing the file ends the agent, a child it started, and its folder;
   - an agent that exits says why;
   - sign-in uses only the methods the agent offered.

   `WorkbenchAgentSessionProtocolTests` measures the bridge: file session, access level
   and thread.
2. **The bridge.** ADR-0002's 2026-10-08 note. The repository's own guard,
   `AnActorIsRefusedOnEveryMethodButTheRecordWritesAndPreparingAProposal`, failed on the
   first full gate run. It reported "A method other than the record writes accepted a
   view's actor", naming all nine methods. They had been routed before the actor check;
   they are now routed after it.
3. **The tab and Launch.** Built without a design canvas: the owner asked for the build,
   so it follows the Mica tokens directly. The node lane's `agent-chat.test.mjs` measures
   the merge and that no agent or tool text becomes markup. A headless tour of the
   preview measured these, agent-observed, in both themes:
   - Launch is offered by level and not for a program that was not found;
   - the conversation opens in a second tab, and Open conversation reuses it;
   - Enter sends;
   - a half-typed message survives the agent's replies;
   - End disables the composer.
4. **Finding agents and signing in.** The five known programs are on `PATH`; one command
   of the person's own is kept in device state. `authenticate` is called only with an
   agent-offered method.
5. **The live check.** Agent-observed on 2026-10-08, not a lane. The setup:
   - a Debug host on a new scratch file, with isolated device state;
   - the Workbench driven over WebView2's debugging port: Agent → Shape app → Launch
     GitHub Copilot CLI;
   - Copilot 1.0.93 on `copilot --acp`.

   What happened:
   - It read the file and validated a proposal, "Add Task record type with list screen".
   - That was accepted on the Agent page.
   - Asked again in the same tab, it wrote two Task records. They were read back over
     MCP: "Buy milk" (not done) and "Write report" (done).
   - Every tool call asked permission, with Allow once, Always allow and Deny.
   - Some calls were Copilot's own shell commands, reading its own temporary files. That
     is the unconfined part this decision names.
   - End and the host's exit left none of its processes behind.

   **The check found one defect.** Copilot CLI sends the application handle with every
   owned call, and the permission card showed it. ADR-0009 lets the UI show only
   pseudonyms. The conversation now hides an `applicationHandle` or
   `resumeApplicationHandle` value in tool input and output, plain or escaped.
   `TheAgentsApplicationHandleIsNeverShown` guards it. With the redaction taken out, it
   failed with "The agent's application handle reached the tab".

### The tab as direction A, and the agent's own options (later on 2026-10-08)

After using the build, the owner asked for six designs of the tab and added: "we should
have some agent options, like model, effort, or whatever is available". The canvas
offered A to F, and the owner chose A, a reading thread.

**How the tab looks now:**
- A heading carries the access level and the state.
- The agent's steps between two messages fold into one line that opens.
- Each tool says whether it went through Nendo or was the agent's own.
- A permission request stands where the agent stopped, with Allow once first.

**Options:** the agent's options sit in the composer.
- **Where they come from.** They are the agent's ACP session config options (`model`,
  `thought_level`, `mode`, `model_config`), set with `session/set_config_option`. An
  older agent's `modes` and `models` are set with `session/set_mode` and
  `session/set_model`.
- **What the installed agents offer.** A probe of the installed agents (a session
  opened, no prompt) found:
  - Copilot CLI 1.0.93: config options for Mode, Model, Reasoning Effort, a custom
    Agent and Allow All;
  - OpenCode 1.1.36: the older modes and models.
- **What Nendo does with them.** An option outside the four categories goes under More.
  Nendo sends only a value the agent offered, and only when the person picks it. They
  are the agent's settings, not Nendo's access level, which stays on the Agent page.

**Checks:**
- `DesktopLaunchedAgentTests` covers both forms and the tool origin. Removing the
  offered-value check failed `TheAgentsConfigOptionsAreShownAndSetOnlyAsThePersonPicks`.
- `agent-chat.test.mjs` covers the fold, the permission order and the options' place.
  Putting every option in the composer failed it.
- A preview tour measured the composer docked 46 px from the window's foot, the column
  at 760 px, and Light and Dark.

### A refusal says why, and Launch says what to install (later on 2026-10-08)

The owner launched Claude Code from the installed build. It answered "Invalid API key",
and after the owner removed that key it "refused to start: Internal error". Two causes,
neither in Nendo's protocol:

- The installed adapter came from `@zed-industries/claude-agent-acp`, which stopped at
  0.23.1 when it was renamed to `@agentclientprotocol/claude-agent-acp` (0.88.0 that day).
  The old version refused `session/new` because it did not know the owner's Claude setting
  `permissions.defaultMode: "auto"`. The Codex adapter was renamed the same way. Updating
  under the old name changed nothing.
- The adapter put that reason only in the JSON-RPC error's `data.details`, which Nendo
  dropped.

**What changed:**
- A refusal now carries the reason from `data` (a string, `details` or `message`),
  bounded, with any application handle hidden. `AnAgentThatRefusesToStartSaysWhy` guards
  it; without the detail it failed with "String 'Your command refused to start: Internal
  error' does not contain string 'refused to start: Internal error: Invalid
  permissions.defaultMode: auto.'".
- The catalog names each known program's npm package. Launch shows a missing one's
  install command, and says when a found npm shim starts a package the catalog lists as
  renamed, with the commands that move it. Copy puts either on the clipboard; the host
  still runs nothing. `AnAgentFromARenamedPackageIsToldApartAndAMissingOneSaysWhatToInstall`
  guards the shim reading (matching the package with forward slashes failed it with
  "Expected:<@zed-industries/claude-agent-acp>. Actual:<>"), and `agent-launch.test.mjs`
  guards the rows (dropping the note failed "The renamed package was not said.").
- Bundling an adapter in the installer was considered and rejected: a bundled copy would
  fall behind just as this one did, it would carry Node and a vendor's SDK, and it would
  make one vendor's agent part of Nendo.

### The Agent page as tabs, and agents a person can hide (2026-10-09, W-199)

With Launch on it, the Agent page's left pane (the access ladder, Launch and the connection,
stacked) had grown to 1,331 px while the right pane stood half empty. The owner asked for
four layouts, chose A ("Go for Option A") and added: "allow for deleting (or hiding) agent
options (claude, codex, custom ...). Eg, at work we only have Copilot."

**What changed:**
- The page is the state, the access level as one row, and three tabs: **Activity** (pending
  changes, recent activity, who is working; the default, where proposals wait), **Launch**
  (a tile per agent, the running one first) and **Connect** (the address, the copy buttons,
  the port and lease settings). Anything that waits for the person, an outcome or automatic
  actions to approve, stays above the tabs. The tab chosen and the keyboard focus survive the
  status poll's three-second redraw.
- Any agent can be hidden, the person's own command included, and brought back from the line
  under the tiles. That is this device's choice, kept beside the command in
  `agent-launch.json`, never in the file. `agentSession.setHidden` takes the request gate
  (ADR-0002 note). An ID the build does not know is dropped on read. The running agent is never
  hidden from view while it runs.

**Checks:**
- `AnAgentHiddenOnThisDeviceStaysHiddenAndComesBack` covers the bridge method, the store and
  the file's change sequence. Dropping the hidden list when the person's command changed
  failed it with "What the person hid did not survive their own command changing, or a
  restart."
- `agent-launch.test.mjs` covers the tiles, hiding and the tabs. Showing every agent whatever
  was hidden failed "a hidden agent leaves Launch".
- A headless Edge tour of the preview measured all three tabs within 900 px without scrolling,
  the level on one row, the gates' selectors visible on Activity, hide, Show hidden and Show,
  and focus kept through the poll; both themes were looked at.

## Consequences

### Positive

- A person with an agent installed can use it from inside Nendo, with no terminal and no
  registration.
- The product shows the agent story on its own, which ADR-0014 listed as a cost.
- One authority path remains: the launched agent's changes cross the MCP boundary like
  any other client's.
- The host still needs no network and holds no credential.

### Negative

- Nendo now starts a program that can do anything the person's account can do. The person
  could do that from a terminal already, but the button makes it easier, and Nendo's name
  is on the button.
- ACP is young, and adapters change. A known command can stop working after an agent
  update. The host refuses an unknown protocol version by name rather than guessing.
  Adapters also move: an old package name keeps its last version for good, and the
  catalog's list of renamed packages needs keeping up by hand.
- A second surface for agent output: the tab must render tool calls and permission requests
  well enough to be trusted. That is real UI work.
- A person without an ACP-capable agent installed still has no agent.

## Rejected alternatives

- **AG-UI between host and tab.** ACP already carries typed events for the same things. A
  translation layer adds a contract and no capability.
- **AG-UI to a hosted agent, or an in-process model client.** Each brings back the provider
  dependency, credential custody and network posture ADR-0014 rejected, and the evidence
  has not changed.
- **Declaring file-system and terminal capabilities so Nendo mediates them.** It would make
  Nendo a file and shell broker for the agent, which the vision's axiom excludes, and it
  would not stop an agent's own built-in tools.
- **Auto-allowing permission requests at Unattended.** Unattended is about the file. A
  permission request is usually about the computer. The person answers it.
- **Keeping the transcript in the file.** The file holds the application and its history. A
  conversation is the person's working notes, and it would carry whatever the agent read.

## Revisit triggers

- Evidence that launched agents do harm through their own tools that a person did not
  expect from the tab.
- An ACP version that changes the session or permission model.
- A wish to keep or resume conversations (`session/load`), which needs a decision on where a
  transcript lives.
- A need to reach an agent that does not run on this computer.
