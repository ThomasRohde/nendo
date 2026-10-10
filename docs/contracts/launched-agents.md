# Launched agents contract

This contract covers the agent a person launches from the Agent page: which programs
the host offers, the `agentSession.*` bridge methods, what the host tells the agent over
the Agent Client Protocol (ACP), the conversation the tab reads, and what ends it.

- **Decision:** [ADR-0030](../decisions/0030-launch-the-persons-own-agent-over-acp.md)
- **Code:** `src/Nendo.Desktop/Agents/` (the catalogue, the process, the ACP conversation
  and the bridge methods); the Workbench's Launch tab and conversation tab in
  `agent-launch-model.ts`, `agent-chat-model.ts`, `agent-context-model.ts` and
  `view-agent-chat.ts`.

The host is an ACP client and nothing more. It contains no model client, carries no
provider dependency and holds no credential. A launched agent reaches the open file only
through the file's own MCP address, at the access level the person chose, under the same
boundary, leases and change-set gate as any other client ([MCP interface](mcp-interface.md)).
The tab's gating is a convenience, not the protection.

## When Launch is offered

Launch is possible when a file is open with agent access, its listener is ready, and the
level is **Inspect or higher** (`DesktopSessionController.LaunchRefusal`). Otherwise
`agentSession.list` says `canLaunch: false` with the `reason` the Agent page shows: no file
open, a file open read-only, a file that is not healthy, a level of Off, or a listener that
is not ready. `agentSession.launch` then refuses as `agent-launch-unavailable` with the same
sentence.

One launched agent runs per file window. While one runs, another launch is
`agent-already-running`. Launching after it has ended replaces the ended conversation.

## What is offered

`DesktopAgentCatalog` knows five agents and the command that starts each as an ACP agent on
stdio: `copilot` (`copilot --acp`), `gemini` (`gemini --experimental-acp`), `claude`
(`claude-agent-acp`), `codex` (`codex-acp`) and `opencode` (`opencode acp`). It looks for
each on this computer's `PATH`, as a terminal would, accepting `.exe`, `.cmd`, `.bat` and
`.com`; a batch file runs under the command interpreter, anything else directly. The person
may add one command line of their own, offered as `custom`, at most 1,000 characters.

The host never downloads, installs or updates an agent and reads no registry over the
network. For each known agent it names the npm package that provides it. A missing agent
carries `installCommand` (`npm install -g <package>`). An agent whose npm shim (read only
when it is a `.cmd` of at most 16 KiB) starts a package that was renamed and no longer gets
updates carries `renamedFrom` and `updateCommand`, one command a line. These commands are
for the person to run in a terminal; the host shows them and never runs them.

`agentSession.list` answers:

```text
{ canLaunch, reason,
  agents: [{ id, name, commandLine, found, package, installCommand, renamedFrom, updateCommand }],
  customCommandLine, running, hidden }
```

`found` is whether the program was found on `PATH`. `package`, `installCommand`,
`renamedFrom` and `updateCommand` are null for the person's own command. `running` is
`{ agentId, name, state, working }` for an agent that has not ended, else null. `hidden`
lists the agents the person hid on this device, by ID, `custom` for their own command. A
hidden agent is still listed in `agents`, so the page can offer to show it again
(`host-types.ts`, `LaunchableAgents`).

The command line and the hidden IDs are kept for this device only, never in the file, in
`agent-launch.json` under the device state (at most 4,096 bytes, written under the device
state lock). An ID this build does not know is dropped when it is read.

## The bridge methods

The Workbench reaches the conversation with eleven methods
(`WorkbenchProtocol.Agents.cs`). Each names the file session it belongs to in the request's
`fileSessionId`; a request for a session that is no longer open is `stale-file-session`.
All eleven run away from the UI thread (`WorkbenchMethods.OffUiThread`). They are dispatched
after the actor check, so a request that names a custom view's `actor` is refused as
`actor-not-allowed`; the extension broker's closed method table names none of them.

Four methods take the request gate: `agentSession.list`, `agentSession.setCommand`,
`agentSession.setHidden` and `agentSession.launch`. The other seven do not wait on it, and
check `fileSessionId` themselves: the tab must keep reading while an agent's own write holds
the file. Each of those seven except `read` refuses as `agent-not-launched` when no agent
has been launched for the file.

| Method | Payload | Answer and refusals |
| --- | --- | --- |
| `agentSession.list` | none | The list above. |
| `agentSession.setCommand` | `commandLine`, at most 1,000 characters; empty or absent forgets it | The list. `agent-command-not-saved` when the device could not keep it. |
| `agentSession.setHidden` | `agentId` (at most 40 characters), `hidden` | The list. An ID that is neither a known agent nor `custom` is a validation refusal; `agent-choice-not-saved` when the device could not keep it. The file is not written. |
| `agentSession.launch` | `agentId` (at most 40 characters) | The conversation at `starting`; the handshake runs on. `agent-launch-unavailable`, `agent-already-running`, `agent-not-found` (the program was not found on this computer), `agent-start-failed` (Windows could not start it), or a validation refusal for an agent the page does not offer. |
| `agentSession.read` | `after` | The conversation, or `exists: false` when none was launched. |
| `agentSession.prompt` | `text`, `after`, optional `context` | Below. `agent-not-ready` (still starting, signing in or ended), `agent-working` (a turn is running). |
| `agentSession.answer` | `entryId` (at most 40), `optionId` (at most 200), absent to cancel | `agent-question-gone` when the agent no longer waits; a validation refusal for an option the agent did not offer. |
| `agentSession.cancel` | `after` | Stop: `session/cancel` for the running turn, and every open permission request answered as cancelled. |
| `agentSession.authenticate` | `methodId` (at most 200) | `agent-not-signing-in` unless the agent waits to sign in; a validation refusal for a way it did not offer. The sign-in runs on. |
| `agentSession.setOption` | `configId` (at most 200), `value` (at most 300), `after` | `agent-not-ready`; a validation refusal for an option or value the agent did not offer; `agent-option-refused` when the agent refused or did not answer within 30 seconds. |
| `agentSession.end` | `after` | Ends the agent and keeps the transcript. |

Every method except `list`, `setCommand` and `setHidden` answers with the conversation:

```text
{ exists, agentId, name, commandLine, endpoint, level, state, working, notice,
  agentTitle, revision, entries, more, signInMethods, options }
```

`state` is `none`, `starting`, `signIn`, `ready` or `ended`. `level` is the access level's
display name now. `endpoint` is the one MCP address the agent was given.

## Reading the conversation

The conversation counts its changes in one revision. Each entry carries the revision at
which it last changed, so a reader asks only for what changed after the revision it holds.
`agentSession.read` with `after` returns the entries whose revision is later, in revision
order, at most 200 at a time. When more remain, `more` is true and `revision` is the last
returned entry's, so the next read continues from it; otherwise `revision` is the
conversation's own (`AgentConversation.Read`).

The `agentSessionChanged` event carries the conversation's revision and nothing else
(`WorkbenchEvents.AgentSessionChanged`). The tab reads what changed with
`agentSession.read`. A conversation that has been replaced, or whose file has closed,
raises no event.

An entry is `{ id, order, revision, kind, text, title, toolKind, status, input, options,
answer, plan, origin }`, where `kind` is `you`, `agent`, `thought`, `tool`, `plan`,
`permission` or `notice`. The agent's message and thought chunks are joined into one entry
until something else intervenes. A tool call is one entry, updated in place. The plan is one
entry, replaced whole each time the agent states it. `origin`, on a tool or a permission
request, is `nendo` when the tool's name or input names this file's MCP server or a
`nendo://` address, and `agent` otherwise.

Everything an entry holds is the agent's or a tool's text and is kept as text. A tool's
input and output have the value of any `applicationHandle` or `resumeApplicationHandle`
replaced by `(hidden)`, since whoever holds the handle may write as the agent
([ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md)). The
Workbench draws every entry as text; an agent's message goes through the Markdown subset,
which escapes every character before it adds a tag.

The transcript is bounded: at most 1,000 entries, the oldest dropped first; at most 200,000
characters in one entry; a tool's output cut at 20,000 characters and its input at 2,000.

## A prompt, and what the person points at

`agentSession.prompt` takes `text`, at most 100,000 characters and not empty once trimmed.
Its optional `context` is what the person pointed at with @ in the Workbench: at most eight
items `{ uri, title, text }`. The `uri` is one of the file's own addresses, beginning
`nendo://`, at most 600 characters, with no whitespace. The `title` is 1 to 120 characters
once trimmed. Each `text` is at most 8,000 characters, and the texts together at most
32,000. One refused item refuses the whole message: nothing reaches the agent and no turn
starts (`AgentConversation.Context.cs`). The person's entry names the items in its `title`.

The ACP prompt is the person's words first, then the items. An agent that declared
`agentCapabilities.promptCapabilities.embeddedContext` at `initialize` gets each item as a
`resource` block carrying its address and its text as `text/markdown`. Any other agent gets
a `resource_link` for each item, which every ACP agent reads, followed by one text block with
the descriptions. The Workbench writes those descriptions, with the IDs the agent needs, in
`agent-context-model.ts`.

## What the host tells the agent

The handshake is ACP protocol version 1, bounded at 90 seconds (`AgentConversation.cs`).

- `initialize` declares no file-system and no terminal client capability
  (`fs.readTextFile`, `fs.writeTextFile` and `terminal` all false). An agent that answers
  another protocol version, or does not declare `agentCapabilities.mcpCapabilities.http`, is
  ended with a sentence that names why.
- `session/new` names exactly one MCP server: the open file's own address, as an `http`
  server called `nendo` with no headers. The working directory is a new, empty folder.
- When the agent answers `session/new` with ACP's `auth_required`, the conversation waits
  at `signIn` and names the ways the agent offered (at most eight). The agent program does
  the signing in, within five minutes; no secret passes through Nendo.
- The only request from the agent the host answers is `session/request_permission`. Any
  other is answered as a method not found. A permission request is shown with the agent's
  own options, at most eight, and waits for the person. The host never answers one by
  itself; Stop, End, or the end of the connection answers it as cancelled.
- The agent's own options (its model, effort, mode, or anything else it offers as a
  `select` config option; at most 16, each with at most 300 values) are shown as the agent
  states them and set with `session/set_config_option` only when the person picks a value.
  An agent that sends no config options but `modes` or `models` has them shown as Mode and
  Model and set with `session/set_mode` and `session/set_model`
  (`AgentConversation.Options.cs`).

## Lifetime

The program runs in a new empty folder under the device state's `agent-sessions`, never in
or around the folder that holds the `.nendo` file, with the person's own environment, which
is where it finds its sign-in. It is placed in a Job Object that ends it, and every process
it started, when the job's handle closes: when the conversation ends, and when the host
ends for any reason (`AgentProcess.cs`). The last 4,000 characters of its error output are
kept, so a program that stops on its own can say why in the notice.

Ending the agent ends the program and everything it started, removes its folder and keeps
the transcript (`DesktopLaunchedAgent.EndAsync`). It ends when:

- the person ends it (`agentSession.end`), or starts a new session, which ends it and
  launches the same agent again;
- the Workbench closes its conversation tab, which calls `agentSession.end`
  (`view-agent-chat.ts`);
- the program stops on its own;
- agent access stops: the level set to Off, a listener that could not start again, or a
  file replacement;
- the listener restarts at another address, which happens without a fixed port: the notice
  names the new address;
- the file closes, which also drops the conversation.

A level change that keeps the address keeps the agent; its next MCP call meets the new
level.

The transcript lives in the host's memory from launch until the file closes or another
agent is launched. It is never written to the file or to the device. What the device keeps
is the person's command line and the agents they hid, and, only while an agent runs, its
empty working folder.

## What Nendo cannot confine

The program is the one the person would run in a terminal, with the same abilities. Nendo
gives it no file-system or terminal capability, an empty working folder and only the file's
MCP address at the person's level. It does not sandbox the program, and an agent's own
tools are its own. The axiom that agents never receive raw SQL or file-system authority
holds for what Nendo grants, not for what the person's own program can do on this computer.

## What pins it

- [`DesktopLaunchedAgentTests`](../../tests/Nendo.Desktop.Tests/DesktopLaunchedAgentTests.cs),
  against a stand-in agent that records what it was told
  (`tests/Nendo.Desktop.Tests/TestFixtures/fake-acp-agent.mjs`): the capabilities declared
  off, one MCP server and it the file's address, an empty working folder outside the file's
  folder, the refusals by name, Launch from Inspect upward and refused at Off, permission
  requests that wait for the person, Stop, the handle hidden, the end on file close with the
  program, its child and its folder gone, a level change that keeps the agent and Off that
  ends it, an address that moves, sign-in, the agent's options, `origin`, and what the
  person points at with its bounds.
- [`WorkbenchAgentSessionProtocolTests`](../../tests/Nendo.Desktop.Tests/WorkbenchAgentSessionProtocolTests.cs):
  the methods on the bridge, `stale-file-session`, `agent-launch-unavailable`,
  `agent-not-launched`, every method off the UI thread, no file path in the list, and hiding
  kept on the device without a write to the file.
- The Workbench's node tests
  [`agent-chat.test.mjs`](../../src/Nendo.Workbench/scripts/agent-chat.test.mjs),
  [`agent-context.test.mjs`](../../src/Nendo.Workbench/scripts/agent-context.test.mjs) and
  [`agent-launch.test.mjs`](../../src/Nendo.Workbench/scripts/agent-launch.test.mjs): reads
  merged by revision, nothing an agent, a tool, the file or the host names becoming markup,
  the bounded @ menu and its descriptions, and the Launch tab's missing, renamed and hidden
  agents.
