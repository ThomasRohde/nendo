# ADR-0033: A custom view messages the launched agent

- **Status:** Accepted
- **Date:** 2026-10-20
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `DesktopLaunchedAgentTests` against the stand-in ACP agent; `WorkbenchAgentSessionProtocolTests`; `extension-broker.test.mjs` and `view-assistant.test.mjs`
- **Amends:** ADR-0013 (the method table gains `assistant.*`), ADR-0030 (a view may send a message; the agent's settings move to the Agent page)
- **Depends on:** ADR-0009, ADR-0013, ADR-0030
- **Contract:** [custom views](../contracts/custom-views.md), [launched agents](../contracts/launched-agents.md)

## Context

An agent reaches a file over MCP, and since ADR-0030 a person can launch one from the Agent page.
The other direction does not exist: a custom view cannot ask the running agent anything. A view that
wants "summarise these notes" or "draft the next chapter" has to tell the person to open the tab and
type it.

The launched agent is the person's own program. It has their shell and file tools, and Nendo does
not confine it. A view's code comes from the file, which may be someone else's. A view that could
prompt the agent unseen could have it do anything the person's account can.

## Decision

**A view may send a message into the file's one launched-agent conversation and receive the whole
reply of its own turn.** It never chooses the agent or its settings, never answers a permission
request, and never reads the rest of the transcript.

**The API.** `nendo.assistant.status()`, `nendo.assistant.ask(text, { context })`,
`nendo.assistant.cancel()` and the event `assistant`. The broker methods are `assistant.status`,
`assistant.ask` and `assistant.cancel`; `agent.*` stays outside the method table.

- `status` answers `{ state, name, working, access }`: the conversation's state (`none`, `starting`,
  `signIn`, `ready`, `ended`), the agent's name, whether a turn runs, and the person's choice for
  views. Nothing about model, effort or mode.
- `ask` takes the message and up to eight `nendo://` items, bounded as the composer's @ items are.
  It answers once the turn ends: `{ reply, stopReason }`, the agent's message text of that turn
  only, at most 100,000 characters, with application handles hidden as everywhere else.
- `cancel` stops the view's own turn and nothing else.
- The event carries the same status when it changes.

**The person decides, in Nendo's own cards.** The view never draws them and cannot fake one.

- **Views may message the agent** is a setting on the Agent page, kept on this device: **Never**,
  **Ask** (the default) or **Always**. At Never `ask` is refused at once, without a card.
- No agent running, at least one installed: a card names the view and the first line of its message and
  offers to launch an agent. It lists every agent installed and shown, in the Agent page's order,
  with the one last launched here selected (or the first, when that one is gone or hidden), and the
  person may pick another before launching. The view's message names no agent and the view never
  learns which was offered. Under the agents, the card shows the chosen agent's settings as
  pickers, built from the options it offered when it last ran here and set to the values kept
  for it (ADR-0030); what the person picks there is kept and sent before the agent is ready. An
  agent that has never run here has no settings to show: the card launches it, and once it is
  ready a second card shows its own settings, set as the person picks, and sends the message only
  on Send. Launching from the card counts as consent for that view; the message waits until the
  agent is ready, and sign-in happens in the tab. Not now refuses.
- Agent running, setting Ask, the view's first message in this conversation: a card asks whether
  the view may message the agent. Allow holds until the conversation ends; nothing is stored.
- Launch not possible (access Off, read-only, recovery) or no agent installed: a card says why and
  links the Agent page.
- A view that was told Not now is refused without a card until the conversation changes.

**One turn at a time.** ACP runs one turn per session, and neither version 1 nor its drafts
specify queueing or steering. A view's message that arrives during a turn waits in the host, in
order, and is sent when the turn before it ends; it enters the transcript then. At most 8 wait,
at most 2 from one view; past that `ask` is refused as `assistant-busy`. A view's `cancel` drops
its waiting message or stops its running turn. The person's Stop stops the running turn and drops
every waiting message. The person's own message is refused during a turn, as the tab offers
Stop.

**In the conversation.** The view's message enters the transcript as the person's own would,
marked with the view's title, so the person sees everything sent in their name. Permission requests
go to the person in the tab as always; while they are elsewhere a notice says the agent is asking and
opens the tab. The view's results reach it through the file: the agent writes records over MCP at the
person's level, and the view hears `changes`. The reply text is a convenience beside that.

**The agent's settings are the person's.** Model, effort, mode and any other option the agent
offers are shown and set on the Agent page while it runs, and on a view's launch card before it
starts; the conversation tab shows none. A view has no way to read or set them.

**Unchanged.** ADR-0009's levels, leases and change-set gate apply to whatever the agent does; a view
still writes only as its own package; the kill switch (`views-off`) stops `assistant.*` with every
other method.

## Consequences

- A view can hand the person's agent a task and use the result, with the person seeing every
  message and every permission request.
- A file's code can now start work in a program Nendo does not confine. The person's consent per
  conversation and the Never setting are the guard, not a sandbox.
- One conversation is shared: a view's turn delays the person's, and the agent's context carries
  both.
- Messages queue rather than steer: a view cannot redirect a turn already running, only stop
  its own.
- Views written for this need the agent's reply as text, or the agent to write records the view
  reads; neither is a typed result.

## Rejected alternatives

- **The view fills the composer and the person presses Send:** no new trust, but the view cannot
  use the answer, which is what the person asked for.
- **A background session per view:** turns the person cannot see, and a second program per file.
- **Streaming the reply to the view:** more protocol for little gain; results belong in records.
- **Refusing every message during a turn:** every view would write its own retry loop.
- **Steering by cancelling the running turn and sending again:** ACP has no steering, and a
  cancel throws away the running turn's work, perhaps the person's own.
- **The card launches the agent last launched, with no choice:** a person with two agents
  installed had to leave for the Agent page to use the other.
- **The view names the agent:** the agent is the person's program, chosen by the person.
- **Launching first and asking for the settings before every view's message:** an extra card
  each time; it is kept only for an agent whose settings Nendo has never seen.
- **Settings in the agent's command line:** only some agents take such flags, each spelled its
  own way.
- **Model or effort per message:** the agent's settings are the person's, set in one place.
- **Consent kept on the device per package:** a stored grant outlives the conversation the person
  looked at; the Always setting covers the person who wants no cards.

## Revisit triggers

- A view does harm through the agent that the person did not expect from the card.
- Views need a structured result rather than text.
- A wish for views to run work in the background without the shared conversation.
