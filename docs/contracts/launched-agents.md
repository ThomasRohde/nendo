# Launched agents contract

This contract covers the agent a person launches from the Agent page: which programs the
host offers, the `agentSession.*` bridge methods, what the host tells the agent over the
Agent Client Protocol (ACP), the conversation the tab reads, and what ends it.

- **Decision:** [ADR-0030](../decisions/0030-launch-the-persons-own-agent-over-acp.md),
  [ADR-0033](../decisions/0033-a-view-messages-the-launched-agent.md) for a custom view's messages
- **Code:** `src/Nendo.Desktop/Agents/`; in the Workbench, `agent-launch-model.ts`,
  `agent-chat-model.ts`, `agent-context-model.ts` and `view-agent-chat.ts`.

The host is an ACP client and nothing more: no model client, no provider dependency, no
credential. A launched agent reaches the open file only through the file's own MCP address,
at the person's access level, under the same boundary, leases and change-set gate as any
client ([MCP interface](mcp-interface.md)). The tab's gating is a convenience, not the
protection.

## When Launch is offered

Launch needs a file open with agent access, a ready listener and a level of **Inspect or
higher** (`DesktopSessionController.LaunchRefusal`). Otherwise `agentSession.list` says
`canLaunch: false` with the `reason` the page shows (no file, read-only, not healthy, Off,
listener not ready), and `agentSession.launch` refuses as `agent-launch-unavailable` with
that sentence. One launched agent runs per file window: another launch while it runs is
`agent-already-running`; launching after it ended replaces the ended conversation.

## What is offered

`DesktopAgentCatalog` knows five agents and the command that starts each as an ACP agent on
stdio:

| ID | Command |
| --- | --- |
| `copilot` | `copilot --acp` |
| `gemini` | `gemini --experimental-acp` |
| `claude` | `claude-agent-acp` |
| `codex` | `codex-acp` |
| `opencode` | `opencode acp` |

Each is looked for on `PATH` as a terminal would, accepting `.exe`, `.cmd`, `.bat` and
`.com`; a batch file runs under the command interpreter, anything else directly. `PATH` and
the other variables are the ones Windows holds now: the machine's and the person's are read
from the registry each time, over the host's own (`AgentEnvironment.cs`). `USERNAME`,
`USERDOMAIN`, `USERDOMAIN_ROAMINGPROFILE`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`,
`LOCALAPPDATA` and `LOGONSERVER` stay the host's (the machine key names `USERNAME=SYSTEM`),
and an expandable value is expanded against the environment being built. The person may add
one command line of their own, `custom`, at most 1,000 characters.

The host never downloads, installs or updates an agent and reads no registry over the
network. For each known agent it names the npm package. A missing agent carries
`installCommand` (`npm install -g <package>`). An agent whose npm shim (read only when it is
a `.cmd` of at most 16 KiB) starts a renamed package carries `renamedFrom` and
`updateCommand`. The person runs these in a terminal; the host never runs them.

`agentSession.list` answers:

```text
{ canLaunch, reason,
  agents: [{ id, name, commandLine, found, package, installCommand, renamedFrom, updateCommand, settings }],
  customCommandLine, running, hidden, lastAgentId, viewAccess, startInRepository, repositoryFolder }
```

`found` is whether the program is on `PATH`. The package fields are null for `custom`.
`settings` is null for an agent that has not been ready on this device; otherwise it is
`[{ id, name, category, value, values: [{ value, name, group }] }]`, the `select` options the
agent offered when it was last ready or last had one set, each with `value` the one the person
last picked, or else the one the agent stated then (`DesktopAgentOptionsStore`).
`running` is `{ agentId, name, state, working }` for an agent that has not ended, else null.
`hidden` lists the agents hidden on this device (`custom` included); a hidden agent is still
in `agents` so it can be shown again (`host-types.ts`, `LaunchableAgents`). `lastAgentId` is
the agent last launched on this device, which a view's card selects among the agents it lists
(those `found` and not `hidden`); the person may launch another from the card. `viewAccess` is whether
custom views may message the agent: `never`, `ask` (the default) or `always`.
`repositoryFolder` is the open file's repository, the nearest folder above it that holds `.git`
(a folder, or a worktree's file) or else the file's own folder; `startInRepository` is whether
this file's agent starts there rather than in an empty folder. The command line, hidden IDs,
last agent, view access and the files whose agent starts in their repository (at most 32, by
full path, the most recently chosen kept) are kept only on this device, in `agents\launch.json`
under the device state (at most 16 KiB, written under the device state lock); an unknown ID or
a path that is not fully qualified is dropped on read.

## The bridge methods

Sixteen methods (`WorkbenchProtocol.Agents.cs`). Each names its file session in
`fileSessionId`; a session no longer open is `stale-file-session`. All run off the UI thread
(`WorkbenchMethods.OffUiThread`) and are dispatched after the actor check, so a request
naming a custom view's `actor` is `actor-not-allowed`; the extension broker's method table
names none of them.

`list`, `setCommand`, `setHidden`, `setViewAccess`, `setStartIn` and `launch` take the request gate, finding the agents
first, since that reads nothing of the file: one `PATH` search at a time, shared by requests
that arrive while it runs or within two seconds of its start. The other ten do not wait on
the gate and check `fileSessionId` themselves, so the tab keeps reading while an agent's own
write holds the file. Each of those except `read` is `agent-not-launched` when no agent was
launched for the file, and may name the `conversationId` the tab holds; one naming a
replaced conversation is `agent-conversation-replaced` and reaches nothing, since entry IDs
restart with every launch.

| Method | Payload | Answer and refusals |
| --- | --- | --- |
| `agentSession.list` | none | The list above. |
| `agentSession.setCommand` | `commandLine`, at most 1,000 characters; empty or absent forgets it | The list. `agent-command-not-saved` when the device could not keep it. A changed command forgets the settings kept for `custom`. |
| `agentSession.setHidden` | `agentId` (at most 40), `hidden` | The list. An unknown ID is a validation refusal; `agent-choice-not-saved` when the device could not keep it. The file is not written. |
| `agentSession.setViewAccess` | `access`: `never`, `ask` or `always` | The list. Anything else is a validation refusal; `agent-choice-not-saved` when the device could not keep it. |
| `agentSession.setStartIn` | `repository`: true or false | The list. Start this file's agent in its repository, or in an empty folder again, from the next launch; `agent-choice-not-saved` when the device could not keep it. |
| `agentSession.launch` | `agentId` (at most 40), optional `settings`: at most 16 `configId: value` pairs (at most 200 and 300 characters), each one of that agent's kept `settings` and a value it offered | The conversation at `starting`; the handshake runs on. `settings` are kept as the person's picks before the agent starts. `agent-launch-unavailable`, `agent-already-running`, `agent-not-found` (not on this computer), `agent-start-failed` (Windows could not start it), `agent-folder-missing` (the repository chosen is gone), or a validation refusal. |
| `agentSession.read` | `after` | The conversation, or `exists: false`. |
| `agentSession.attach` | `uploadKey` (at most 80), `offset`, `base64`: one chunk of a picture for the next message | `{ staged }`, the bytes held under that key. `agent-takes-no-images` for an agent that does not read pictures; `agent-image-too-large` once the picture passes 5 MiB, which drops it. |
| `agentSession.prompt` | `text`, `after`, optional `images`, optional `context`, optional `from` (a custom view's title, at most 120) | Below, with `turnId`. `agent-not-ready` (starting, signing in or ended); `agent-working` for the person's message during a turn, or a view's past the queue's bound; `assistant-off` for a view's message while views are Never. |
| `agentSession.image` | `imageId` (at most 20), `offset` | `{ base64, length, mediaType, next }`: 150,000 bytes of a picture an entry shows, from `offset`; `next` is null at the end. `agent-image-gone` once the conversation no longer keeps it. |
| `agentSession.turn` | `turnId` (at most 40) | `{ turnId, done, reply, stopReason }`. `agent-turn-gone` once it is no longer kept. |
| `agentSession.answer` | `entryId` (at most 40), `optionId` (at most 200), absent to cancel | `agent-question-gone` when the agent no longer waits; a validation refusal for an option not offered. |
| `agentSession.cancel` | `after`, optional `turnId` | Without `turnId`, the person's Stop: `session/cancel` for the running turn, every open permission request answered as cancelled, and every waiting message dropped. With `turnId`, a view's own turn: dropped while it waits, cancelled as Stop while it runs, nothing once ended. |
| `agentSession.authenticate` | `methodId` (at most 200) | `agent-not-signing-in` unless the agent waits to sign in; `agent-signing-in` while a sign-in started here runs; a validation refusal for a way not offered. `signingIn` is true until it ends. |
| `agentSession.setOption` | `configId` (at most 200), `value` (at most 300), `after` | `agent-not-ready`; a validation refusal for an option or value not offered; `agent-option-refused` when the agent refused or did not answer within 30 seconds. |
| `agentSession.end` | `after` | Ends the agent and keeps the transcript. |

Every method except `list`, `setCommand`, `setHidden`, `attach` and `image` answers with the conversation:

```text
{ exists, conversationId, agentId, name, commandLine, endpoint, level, state, working,
  notice, agentTitle, revision, entries, more, signInMethods, options, firstOrder,
  signingIn, commands, queued, takesImages, usage, sessionTitle }
```

`takesImages` is whether the agent declared `agentCapabilities.promptCapabilities.image` at
`initialize`. `usage` is how full the agent's context is, from its last `usage_update` Nendo could
show: `{ used, size, costAmount, costCurrency }`, null until it sends one
(`AgentConversation.Usage.cs`). An update without a whole, non-negative `used` and a `size` above
zero is ignored and the last one stays; a `cost` that is not a non-negative `amount` with a
three-letter upper-case `currency` is left out and the use kept. It is the agent's count, never
Nendo's. The tab shows it as a chip beside the agent's, `N% of context`, with the tokens and the
cost on hover, in the warning colour from 80% (`usageChip`, `agent-chat-model.ts`).

`sessionTitle` is the agent's name for the conversation, from its `session_info_update`, null
until it gives one (`AgentConversation.SessionInfo.cs`). The update is partial: one without
`title` leaves it, a null `title` clears it. It is one line, white space folded, at most 200
characters and redacted like every agent text. The tab shows it beside the agent's name in the
conversation's heading; the tab itself keeps the agent's name.

`queued` is the number of views' messages waiting for the running turn.
`conversationId` is new for each launch, null when none was launched. `state` is `none`,
`starting`, `signIn`, `ready` or `ended`. `level` is the access level's display name now;
`endpoint` the one MCP address the agent was given. `firstOrder` is the order of the oldest
entry kept. `signingIn` is true while a sign-in the person started runs; the tab holds the
ways to sign in until then. `commands` is the agent's slash commands from its last
`available_commands_update`, each `{ name, description, hint }` (name without its slash,
`hint` null for no input); a name with white space, an empty one or a repeat is left out,
and at most 200 are kept. Running one is `agentSession.prompt` with text starting `/name`,
sent like any message and never checked against the list.

## Reading the conversation

The conversation counts its changes in one revision, and each entry carries the revision at
which it last changed. `agentSession.read` with `after` returns the entries changed later, in
revision order, at most 200 at a time. When more remain, `more` is true and `revision` is the
last returned entry's; otherwise it is the conversation's (`AgentConversation.Read`).

The `agentSessionChanged` event carries only the revision
(`WorkbenchEvents.AgentSessionChanged`). A replaced conversation, or one whose file closed,
raises none. A new access level that keeps the agent raises it with the revision unchanged.
The tab fixes which launch a read is of before sending it, drops an answer that arrives
after New session or a file change, never merges a read whose `conversationId` differs
(`mergeChat`), and drops every entry before `firstOrder`.

An entry is `{ id, order, revision, kind, text, title, toolKind, status, input, options,
answer, plan, origin, images, error }`, `kind` one of `you`, `agent`, `thought`, `tool`, `plan`,
`permission`, `notice`, `compaction`. Message and thought chunks join into one entry until something else
intervenes, or until a chunk names another message by its ACP `messageId`, which starts a new
entry; a chunk that names none joins the entry open before it. A tool call is one entry, updated in place; a diff in its content is kept as its
path and the text before and after (each cut at 8,000 characters). The plan is one entry,
replaced whole each time.

`origin`, on a tool or permission request, is judged only from what names the tool: the
tool name in the agent's `_meta` (`toolName`, at most two levels down), its title and its
kind. It is `nendo` when that name or the title names this file's MCP tools, or the title
names a `nendo://` address and the kind is not `execute`; otherwise `agent`. A given tool
name alone decides. A server prefix counts only when it is the session's own server,
`nendo`: `mcp__nendo-planner__nendo_data_delete_record` is another registered server, so
`agent`. What a tool sends is never evidence.

A permission request's `text` is what its tool call says it would do: its content (a diff,
text) and the places it names (`Where: path:line`), or else the tool call's text. The tab
offers that text and the input before the person answers.

**Notices and compactions** (`AgentConversation.Notices.cs`). The agent's `notice` is a `notice`
entry with `origin` `agent`: `title` its title (at most 300 characters; one without a title is
not shown), `text` its description (at most 2,000), `status` its severity, `info`, `warning` or
`error`, any other shown as `info`. A notice the same as the one just before it is not added
again. Nendo's own notices (the agent stopped, an option it refused) carry no `origin`. A context
compaction is one `compaction` entry, placed where its ID is first seen, by a
`compaction_update` or a `compaction_summary_chunk`, and patched in place: `status` as the agent
states it (`in_progress` until it says otherwise), `text` its summary, `error` why it failed. A
`summary` or `error` left out of an update stays; `null` clears it, as does an empty `summary`;
a summary chunk appends one block. The tab draws the agent's notice with its severity and title,
and a compaction as one line of its own (the agent shortened, is shortening, could not or stopped
shortening the conversation) with its error and, in a fold, its summary.

**Pictures.** An image block in an agent message, its reasoning or a tool's content is kept when
it carries its bytes inline and those bytes say PNG, JPEG, GIF or WebP (`NendoMedia.Sniff`), at
most 5 MiB (`AgentConversation.Pictures.cs`). SVG, a picture named only by an address, which
Nendo never fetches, and anything else stay the text "(an image)". The conversation keeps at most
32 pictures and 64 MiB of them in host memory, the same bytes once, and drops the oldest first. An
entry names its pictures in `images`, each `{ id, mediaType, length, width, height }` (width and
height where the header says them); a message's picture joins its message by the same rule as its
text. A tool's pictures are drawn under its run of folded steps, each once, in sight while the run
is folded. The tab draws each as an image with no address, reads its bytes with `agentSession.image`,
and fills it from a `data:` address (`agent-pictures.ts`); one no longer kept is said as "(a
picture no longer kept)". What a picture shows is the agent's: Nendo cannot hide an application
handle inside one.

Everything an entry holds is kept as text. Every text the agent writes into the transcript
(messages, reasoning, plans, a tool's title, input and output, a notice carrying its error
output) has any application handle replaced by `(hidden)`: after its key
(`applicationHandle`, `resumeApplicationHandle` or `application_handle`), quoted or not, and,
for any handle a lease grant in this process carried, wherever its value appears. Whoever
holds the handle may write as the agent
([ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md)). Redaction
runs again on each entry as it is read, so a handle split across chunks, or cut off in a
streaming message, is hidden too. The Workbench draws every entry as text; an agent message
goes through the Markdown subset, which escapes every character before adding a tag.

The transcript holds at most 1,000 entries (oldest dropped first) and 200,000 characters per
entry; a tool's output is cut at 20,000 characters and its input at 2,000.

## A prompt, its pictures, and what the person points at

`agentSession.prompt` takes `text`, at most 100,000 characters, not empty once trimmed unless the
message carries a picture.
Its optional `context` is what the person pointed at with @: at most eight items
`{ uri, title, text }`. `uri` is one of the file's `nendo://` addresses, at most 600
characters, no whitespace; `title` 1–120 characters once trimmed; each `text` at most 8,000
characters and all together at most 32,000. One refused item refuses the message: nothing
reaches the agent and no turn starts (`AgentConversation.Context.cs`). The person's entry
names the items in its `title`.

The Workbench keeps a message within those bounds before sending
(`agent-context-model.ts`, `withAttachment`): a description is cut to the room left, keeping
the `nendo://` address that reads the rest; an item that no longer fits, or a ninth, is not
added, its @name is not left in the message, and a line under the chips (also announced)
says why and which item to take back. Names are cut to 120 characters. New session clears
the composer.

**Pictures.** The tab takes a picture pasted into the message box, dropped on it or picked with
its picture button, which shows only when `takesImages` (`agent-images.ts`,
`agent-image-model.ts`). The composer carries `data-media-drop`, so the window's own drop, which
opens a `.nendo` file, leaves a file let go over it to the composer. A picture for an agent that
does not read pictures, a type other than PNG, JPEG, GIF or WebP, one over 5 MiB, a ninth, or
one past 20 MiB together is not added, and the line under the chips says why. When the message
goes, the tab stages each picture with `agentSession.attach` under a new key, in chunks of
150,000 bytes, and names it in `images`: at most eight `{ uploadKey, name }`. The host takes each
from what was staged under its key for this file session, in memory only and dropped after 15
minutes unsent, reads its type from its bytes (`NendoMedia.Sniff`), and refuses the message when
one is missing, empty, of another type (`agent-image-type`, SVG included), past its bound or past
20 MiB together (`agent-image-too-large`), or when the agent does not read pictures
(`agent-takes-no-images`). A staged picture goes with one message only; a refused message keeps
the tab's pictures, and the next send stages them again. The person's entry names the pictures,
then the items, in its `title`.

The ACP prompt is the person's words first, then each picture as an `image` block
(`mimeType`, `data` in base64), then the items. A message of pictures alone has no text block. An agent that declared
`agentCapabilities.promptCapabilities.embeddedContext` gets each item as a `resource` block
with its address and its text as `text/markdown`; any other gets a `resource_link` per item
followed by one text block with the descriptions, which `agent-context-model.ts` writes with
the IDs the agent needs.

## A custom view's messages

A custom view reaches the conversation through the Workbench
([ADR-0033](../decisions/0033-a-view-messages-the-launched-agent.md),
[custom views](custom-views.md#the-method-table)), which asks the person in its own cards and
sends the message with `from`, the view's title. The person's entry and the view's look alike
in the transcript except that the view's carries `from`, which the tab shows above it.

ACP runs one turn at a time in a session. A message with `from` that arrives while a turn runs
waits in host memory, in order, and is sent when the turn before it ends; it enters the
transcript then (`AgentConversation.Turns.cs`). At most 8 wait, at most 2 with the same `from`.
Ending the conversation ends every waiting turn as `ended`.

Each prompt starts a turn, named by `turnId`. A turn's `reply` is the agent's message entries
after its own message, joined by a blank line, at most 100,000 characters, redacted like every
other text. `stopReason` is ACP's (`end_turn`, `cancelled`, `max_tokens`, `max_turn_requests`,
`refusal`), `error` when the agent answered the prompt with an error, or `ended` when the
conversation ended first. The last 16 ended turns are kept, and every turn not ended.

## What the host tells the agent

The handshake is ACP protocol version 1, bounded at 90 seconds (`AgentConversation.cs`).

- `initialize` declares no file-system or terminal capability (`fs.readTextFile`,
  `fs.writeTextFile`, `terminal` all false), and declares `session.configOptions.boolean`,
  `session.notices` and `session.compaction`, so the agent may offer on/off settings and send
  notices and compactions. An agent answering another protocol version, or
  not declaring `agentCapabilities.mcpCapabilities.http`, is ended with a sentence naming
  why; a version sent as text is named as not ACP. A number sent as another JSON kind reads as
  absent, and any other handshake failure ends the conversation with a sentence rather than
  leaving it at `starting`. An error answer whose `code` is not a number is an internal
  error, never the end of the connection.
- `session/new` names exactly one MCP server: the open file's address, as an `http` server
  called `nendo` with no headers. The working directory is the folder the program runs in
  ([Lifetime](#lifetime)); the conversation's `workingFolder` names it when it is the file's
  repository, and is null for an empty folder.
- When `session/new` answers `auth_required`, the conversation waits at `signIn` and names
  the ways offered (at most eight). The agent program signs in, within five minutes; no secret
  passes through Nendo. One sign-in runs at a time, and an update naming another session is
  not drawn.
- The only agent request the host answers is `session/request_permission`; any other is
  method not found. A permission request shows the agent's own options (at most eight) and
  waits for the person; the host never answers by itself. Stop, End or the connection's end
  answers it as cancelled, drawn as cancelled when the turn stopped. The card names the
  tool's kind (Read, Edit, Delete, Run) beside the agent's title.
- The agent's own `select` and `boolean` config options (model, effort, mode or anything else;
  at most 16, each select with at most 300 values) are shown on the Agent page as stated and set
  with `session/set_config_option` only when the person picks a value there
  (`agent-options.ts`). An arrow key on a closed list only looks: Enter, a pick
  from the open list or leaving the list sets it, and More stays open while stepping through. A
  `boolean` option is carried as the values `true` (On) and `false` (Off), with `type: boolean`
  on the option; the Agent page draws it as a switch, set as it is pressed, and Nendo sends it
  with `type: "boolean"` and a JSON boolean `value`. A view's launch card and the kept settings
  offer it as On and Off. Any other option type is left out.
  An agent that sends no config options, only `modes` or `models`, has them shown as Mode and
  Model and set with `session/set_mode` and `session/set_model` (`AgentConversation.Options.cs`);
  ACP has removed `session/set_model`, and it is kept for such an agent alone. An agent that sends
  config options beside `modes` or `models` is set only through its config options, and its
  `current_mode_update` and `current_model_update` are not drawn.
- **Kept settings.** Each value the person sets, on the Agent page or a view's launch card, is
  kept for that agent on this device in `agents\settings.json` under the device state (at most
  256 KiB, written under the device state lock), with the options the agent offered when it was
  last ready or last had one set. When the agent next starts, after `session/new` and before the
  conversation is `ready`, the host sends each kept value the agent still offers and does not
  already hold, one at a time, each bounded at 30 seconds. A value it no longer offers is not
  sent; one it refuses or does not answer leaves a notice entry naming the option, and the
  conversation becomes `ready` all the same. A kept list that would pass the bound drops the
  other agents' option lists first, then this one's; the picks stay. An unknown agent ID is
  dropped on read.

## Lifetime

The program runs in a new empty folder under the device state's `agents\sessions`, named by
the host process and a new GUID, or, when the person chose it for this file, in the file's
repository, where it picks up that folder's instructions, skills, settings and hooks as it would
from a terminal. Either way it runs with the person's environment as Windows holds it at launch.
Nendo removes only the folders it made: ending the agent never removes anything from the
repository, and a sweep looks only under `agents\sessions`. It is placed in a Job Object that ends
it and every process it started when the job's handle closes: when the conversation ends and
when the host ends for any reason (`AgentProcess.cs`). The last 4,000 characters of its
error output are kept for the notice.

Ending the agent ends the program and everything it started, removes its folder and keeps the
transcript (`DesktopLaunchedAgent.EndAsync`). Each launch first removes every folder no
running agent can use: this host's own with no agent in it, another host process's once that
process has ended, and one whose name carries no process unless a program still works in it. Every way the
conversation ends ends the program, a refusal at the handshake included. It ends when:

- the person ends it (`agentSession.end`), or starts a new session, which ends it and
  launches the same agent again;
- the Workbench closes the tab that owns the conversation, which calls `agentSession.end`
  (`view-agent-chat.ts`). The owner is the tab that last showed it, known by the tab, not by
  its trail (a trail drops the conversation after Back and somewhere new, and after 50 more
  places). A new tab opened beside it starts from the place before it, or the Agent page; Open
  conversation goes to the owning tab, so one conversation never has two tabs
  (`workspace-tabs.ts`);
- the program stops, or its connection ends while it runs: the notice says why, for example
  a message over the 8 MiB Nendo accepts;
- agent access stops: Off, a listener that could not restart, or a file replacement;
- the listener restarts at another address (no fixed port): the notice names the new one;
- the file closes, which also drops the conversation.

A level change that keeps the address keeps the agent; its next MCP call meets the new level.

The transcript lives in host memory from launch until the file closes or another agent is
launched, never in the file or on the device. The device keeps the command line, the hidden
agents, the files whose agent starts in their repository and, until the next launch sweeps it,
a working folder of its own.

## What Nendo cannot confine

The program is the one the person would run in a terminal, with the same abilities. Nendo
gives it no file-system or terminal capability, an empty working folder (or the file's
repository, when the person chose it) and only the file's MCP address at the person's level. It does not sandbox the program, and an agent's own tools
are its own. The axiom that agents never receive raw SQL or file-system authority holds for
what Nendo grants, not for what the person's own program can do on this computer.

## Tests

- [`DesktopLaunchedAgentTests`](../../tests/Nendo.Desktop.Tests/DesktopLaunchedAgentTests.cs)
  against a stand-in agent that records what it was told
  (`tests/Nendo.Desktop.Tests/TestFixtures/fake-acp-agent.mjs`), a view's turns and the queue
  among them, an agent started in the file's repository, which ending it leaves whole, and
  settings kept per agent and sent before it is next ready.
- [`WorkbenchAgentSessionProtocolTests`](../../tests/Nendo.Desktop.Tests/WorkbenchAgentSessionProtocolTests.cs):
  the bridge methods, their refusals, off-UI-thread dispatch, device-only hiding and a launch's
  malformed settings.
- The Workbench node tests `assistant-model.test.mjs`, `agent-chat.test.mjs`, `agent-context.test.mjs`, `agent-image.test.mjs`,
  `agent-launch.test.mjs`, `navigation-trail.test.mjs` and `preview-agent-session.test.mjs`
  in `src/Nendo.Workbench/scripts/`.
- [`tools/Review-AgentChat.ps1`](../../tools/Review-AgentChat.ps1), run by
  `Test-Production.ps1`: the built Workbench against the preview's scripted agent, in both
  themes, a picture dropped and pasted on the message box among its checks.
