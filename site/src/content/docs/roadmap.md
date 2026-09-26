---
title: Roadmap and directions
description: Where Nendo is now, the work that is unfinished, the directions it could take, and what would change the plan.
group: Project
order: 10
---

## Where Nendo is now

Nendo is a research prototype. It tests one idea: an application can live in one
local file that people and coding agents reshape in place, with no generated
project and no build step.

The core loop works end to end:

1. Create an empty `.nendo` file.
2. Add record types, fields and records, or import them from CSV.
3. Work with the data in Studio, the built-in table view.
4. Connect a coding agent over local MCP and ask it to build screens,
   calculations or actions.
5. Review the agent's proposal as a semantic diff, and accept or reject it.

The current version is 0.16.0. It runs on Windows x64 only, as an unsigned
per-user install. You build the installer from source; see
[Using Nendo](/nendo/use).

For what is measured, what is reported by the author and what is not supported,
see [Status](/nendo/status). This page does not repeat those tables.

## Near-term work

These items are unfinished now. They are the next work, not new ideas.

### Custom views: the next steps

A custom view's code now lives in the `.nendo` file, and a view that is shown runs
inline in Nendo and reads the file's records. The next steps are, in order:

- views that keep their own state in the file (they already change records, run
  commands and propose changes for you to review);
- a view as a screen of its own, and as a tile on the front page.

None of these is available yet. What is already true, and what is not measured, is
on [Custom views](/nendo/docs/custom-views).

### Distribution and signing

There is no public download. The installer is unsigned and targets Windows x64
only. Public distribution, code signing and an ARM64 build are not started.

### Agent authoring rough edges

Agents author successfully today, but some steps cost more round trips than they
need to:

- Validation reports one error at a time. After you fix it, the next error
  appears. The reason is that validation runs in one database transaction, and
  the first refusal ends that transaction.
- Consent for automatic actions is a separate step from accepting the proposal
  that installs them. The proposal list does not show it.
- An action step that writes to the wrong record installs without error, and
  fails only when it runs.
- A data import commits in batches of fifty rows. If a row is refused, the
  earlier batches stay committed, and the caller cannot skip the refused row and
  continue.

## Possible future directions

The items below are possibilities, not commitments. The repository records each
one as deferred, out of scope or unresolved. Some may never happen, because they
conflict with the eight product axioms on the [concept page](/nendo/concept).
Any of them needs an accepted design decision before work starts.

| Direction | What it would mean | What stands in the way |
| --- | --- | --- |
| Broader extensions | Extension code that runs without a view: contributed commands, event handlers, background work. Signed packages and a trust model. | Custom views carry their code in the file today. Code that runs without a view needs its own design decision. Nothing signs a package, and there is no identity, dependency or update model for packages. |
| General scripting in formulas | Code beyond the bounded calculation language in calculations and actions: loops, objects, compiled code. | Calculations and actions today are closed, pure and bounded. General code there brings isolation questions that nobody has measured. |
| External effects | Actions that send email, call a web service, read files or run on a timer. | These cannot share the local all-or-nothing transaction. They need durable intent, retries, credentials, consent and recovery, and none is designed. |
| Scalar multi-choice | A field that holds several choices at once. | Out of scope by product rule. A choice field holds one option, and no design for several options exists. |
| Binary and asset fields | Images, attachments and other files stored in records. | Out of scope by product rule. The file stores scalar values only, and no design for binary content exists. |
| DateTime in calendars | Times of day, time zones, week and day views, durations, recurrence, drag to reschedule. | A calendar places a Date field on a month. To group a DateTime by day, the host must choose a time zone, and the screen contract does not define one. The host refuses a DateTime field on a calendar or timeline. |
| Collaboration and sync | Several people or devices working on one file. | Out of scope. Nendo is personal and single-user. It warns when a file is in a known cloud-sync folder and makes no claim that sync is safe. |
| Proposal rebase | An older proposal replayed onto a newer file revision, so that a conflict does not appear at validation. | Promotion replays validated operations against the active file. A rebase changes what a conflict means, so it needs its own design. |
| Durable proposals | An agent that reconnects can preview or reject a proposal from its earlier session. | Today a proposal belongs to the session that created it. A longer-lived binding is a change to agent authority. |
| Shared-machine protection | A check that only the signed-in user's processes can reach an open file. | There is no credential today. Every process on the machine can connect at the file's access level. The check is not built. |
| Other platforms | ARM64 Windows, macOS, Linux. | The host is a WinUI and WebView2 application. ARM64 waits for a final production build. Other operating systems need a different host. |
| Broader MCP clients | A stated promise that any MCP client works. | Claude Code and Codex connect with the address alone. Other clients are not tested, and no parity claim is made. |
| An embedded agent | An assistant built into Nendo. | Dropped. The local MCP interface is the agent surface, and local use never depends on an agent. |

## What would change the plan

The project states its own test of whether the idea works. The test has two parts:

1. An agent that has only the MCP interface can build an application of a shape
   that nobody planned for.
2. A person can read that change and understand what it does before accepting it.

Four reference applications exist to test this, each a different shape: Idea
Garden, Decision Log, the Axiom Register and Nendo Station. An agent built the
last two from an empty file through MCP alone.

The stop signal is also stated. If Studio works but the screens that agents build
give no value that the plain table does not already give, the idea has failed.
That result means change direction or stop. It does not mean add more features.

The largest open risk is that everyone who has used Nendo also built it. Nobody
knows yet if a new person can follow it without help. If you try Nendo and
something confuses you, that is useful evidence.
[Open an issue on GitHub](https://github.com/ThomasRohde/nendo/issues) and say
where you got stuck.
