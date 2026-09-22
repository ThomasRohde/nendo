# ADR-0002: Select the containing desktop architecture and process model

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0002 result and EX-0003 result
- **Depends on:** EX-0001 typed kernel services and the EX-0002 host-neutral semantic plan
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Nendo needs a permanent Studio/recovery route, rich table/editor mechanics and
compiled semantic forms and boards while keeping one portable `.nendo` file and
host-owned authority. The containing choice must remain maintainable by one
primary maintainer and must not expose storage or generic privileged calls to a
renderer.

EX-0003 compared actual WinUI-plus-island, one-web-workbench and Avalonia stacks
against the same real fixture and typed contract. Alternative B scored 88/100,
ahead of C at 72 and A at 71. B preserved real renderer-failure recovery while
requiring the least candidate-specific normal-UI code.

## Decision drivers

1. One coherent renderer for Studio, forms and boards.
2. Permanent host-owned Studio, recovery and `.nendo` lifecycle.
3. Closed, testable typed authority boundaries.
4. Mature table/grid path without rebuilding a grid substrate.
5. Renderer crash isolation and restart without losing the host session.
6. Sustainable theme, accessibility, automation and editor maintenance.
7. Local/offline operation and replaceable UI adapters.

## Options considered

### A — WinUI normal shell with WebView2 Studio island

Strongest native Windows surface and smallest failure blast radius, but it
requires two normal renderers for selection, themes, forms, boards, inspectors,
editors and automation. The experiment measured the largest candidate source
and the same seven-process WebView2 runtime tree as B.

### B — thin WinUI host with one local web workbench

One WebView2 renderer owns all normal Studio and semantic surfaces. WinUI owns
only desktop lifecycle and a bounded native recovery/safe-mode surface. This
has the clearest mature-grid path and smallest normal-UI duplication while
retaining a real renderer process boundary.

### C — one Avalonia native/cross-platform stack

One in-process renderer and lowest idle process count. It also has no renderer
failure isolation, a broad restored native-asset graph, weaker observed Windows
automation behavior and no qualified native grid path for DS1.

### Defer

Deferral would block DS1 and encourage production UI work to choose an
architecture by component or prototype momentum.

## Decision

Nendo will use **alternative B** as its containing desktop architecture:

- a thin WinUI 3 / Windows App SDK host owns the desktop window, title-bar and
  operating-system integration;
- the host owns `.nendo` file discovery/open/close, the kernel, typed application
  services, revisions, validation, mutation coordination and recovery;
- one local WebView2 workbench owns every normal Studio, form, board, inspector
  and future product surface;
- WebView2 is a renderer and client of typed application services, never a
  storage or authority boundary;
- a bounded native host surface remains available when the renderer cannot
  start or has failed; it may inspect health, list bounded recovery data and
  restart/repair the renderer, but it is not a second normal editor stack;
- renderer requests use a closed, versioned, named message vocabulary with
  stable semantic IDs, optimistic preconditions and idempotency keys;
- no SQL, SQLite connection/type, database/file path, raw filesystem/network/
  process authority, host-object exposure or generic invocation crosses into
  web content;
- web assets are local/offline and use a restrictive content-security policy.

This ADR does not select React, TypeScript, AG Grid, Node-based production
tooling, packaging technology or the production source-tree layout. Those
choices need their own evidence and may not weaken this responsibility boundary.

## Evidence and validation obligations

EX-0003 proved real windows, equal semantic snapshots, stable targets, typed
mutation/replay/conflict behavior, Light/Dark/System propagation and actual
WebView2 crash recovery. Its result records exact packages, commands,
measurements, screenshots and limitations.

Before ADR-0015 or a production grid choice is Accepted:

- DS1 must qualify the functional table/editor journey and 100/10,000/100,000
  row cases without adding renderer authority;
- DS2 must qualify keyboard focus across the native/WebView seam, UIA/Narrator,
  high contrast, 200% scaling, clipboard, theme/title-bar consistency, renderer
  lifecycle and offline packaging;
- dependency/licence checks must prove that only authorised packages and
  component editions ship;
- safe mode must remain reachable if WebView2 cannot initialize at all.

## 2026-09-02 downstream disposition

DS1 and DS2 subsequently produced the required functional, provider, focus,
high-contrast, packaging and lifecycle evidence. DS2 remains **revise** because
actual 200% Windows scale was not observed. Repository owner Thomas Klok Rohde
explicitly deferred that check to post-selection, pre-release hardening and
Accepted ADR-0015 at Medium confidence. This is not a 200% pass; a material
scaling, accessibility, focus or recovery failure reopens ADR-0015 and this
containing decision.

## 2026-09-15 amendment — the host outlives its window

The original decision gave the host "the desktop window, title-bar and operating-
system integration" and left window lifetime and process lifetime the same thing.
They are now separate.

**What changes.** The close button hides the window into the notification area and
the process stays resident with its file open, its Engine alive and its MCP host
listening. The tray icon's menu carries the real exit, a readout of the current
agent access mode, a way to turn that access off, and a toggle that puts the close
button back to exiting. The preference is device state under the per-user root,
defaulting to the notification area; the process owner can pin it with
`NENDO_DESKTOP_CLOSE_ACTION`, which is what the scripted window lanes use because
none of them can click a tray menu. One icon per window, since Nendo is
multi-instance and each window holds a different file.

The host also gains a notification surface: Windows notifications for the states
that need a person, raised only while the window is hidden or minimised. There are
four — a validated proposal is waiting, a file's automatic actions need consent,
the open file stopped being writable, and the workspace failed. Routing them needs
the first unsolicited message on the Workbench bridge, which is bridge protocol
version 7; a renderer at 2–6 drops it, as it always did with anything lacking a
request id.

**Notifications route; they never grant.** A notification may say a person is
needed and open the page where they answer. It may not carry the answer. Accepting
a proposal rests on promotion verifying the digest that was actually reviewed
([ADR-0007](0007-proposal-clone-validation-and-replay-promotion.md)), and consent
binds an exact digest, contract version, definition revision and capability set
([ADR-0008](0008-general-scripting-and-capability-isolation.md)); neither is a
thing a notification can show, so neither may be answered from one. A notification
is also a surface anyone at the machine can click. `Test-Production.ps1` keeps the
notification types out of the MCP adapter the same way it already keeps approval
out, and a test asserts no notification payload carries an approve, accept,
promote or grant argument.

**What this costs, stated rather than absorbed.**
[ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md) records that
while a file is open with access on, any process on this machine can connect at
that access level. Until now, closing the window was the owner's off switch for
that, because it closed the file. It is not any more: a window that looks shut can
be a process still serving MCP. That is the intended behaviour — an agent working
while nobody watches is the point — but it lengthens the interval the ADR-0009
posture applies to, and nothing about that posture is otherwise changed. The
answers taken here are that the tray menu shows the live access mode and offers to
turn it off, the tooltip names the open file and says when it is waiting on
approval, and the first close on a device explains where the window went. What is
*not* taken is any new credential or peer check; that remains what ADR-0009 calls
the route back, and it is still not built.

**Where this is not qualified.** The notification-area icon, its menu and the
notifications themselves are owner-reported. `tools/Review-ShellRuntime.ps1` drives
a real window and checks that closing hides it, that the process and its file
survive, and that the exit pin still exits — nothing scriptable can enumerate
another process's tray icon or observe a shell notification, and the lane says so
in its own output rather than implying coverage it has not got.

## 2026-09-16 amendment — a screen may not chase its reads without a bound

The app view stopped responding four times in two days. The record written by the
amendment below named it on the fourth: `RenderProcessUnresponsive`, the window visible,
and 9.7 GB of the machine's memory free. The pressure Chromium was logging came from
inside the renderer, not from Windows.

**What it was.** A surface that draws exact numbers asks for the ones it is missing for
the current revision and redraws when they arrive. That is a loop, and it ended only
because the answers normally land. While an agent writes, they never landed: each read
was issued against one change sequence and discarded when the file moved under it, and
the discard cleared the in-flight marks, so the next draw found the same tiles missing
and asked again. The front page redrew as fast as the host could answer, rebuilding the
page every time, until WebView2 declared the renderer unresponsive. The record count was
irrelevant — 125 records did it as readily as 33,000 — and only an agent writing
continuously could produce it, which is why it arrived the day the front page became the
screen Use opens on.

**The rule.** A screen may not chase its reads without a bound. One pass at a time, at
most one a second, and a pass that leaves work outstanding asks to be woken once rather
than redrawing into the next pass. `refreshDerived` already bounded the same chase by
counting attempts and refusing the third; this states it for the reads that are per tile.

**And an answer is not stale because the file moved while it was being read.** It answered
about the revision it was read at, it carries that revision, and it is kept. Discarding it
meant a file being written to could never show a number at all: every answer arrived after
the file had moved, so every answer was thrown away. What must still not happen is an
answer landing on another view or another file, and the generation and file-session guards
are what prevent that. The cost is that while writing continues, tiles on one page may sit
at slightly different revisions; each is exact for the revision it names, and they
converge when the writing stops.

**Nothing redraws under the person's hands.** An open menu, a focused control, an open
dialog, or any pointer, key or focus event in the last 750 milliseconds holds the
automatic redraws off. The first version of this fix honoured only the open menu, and the
owner reported the picker was still "a bit finicky": a redraw landing between the pointer
going down and the menu opening moves the target out from under the click. The Agent
page's poll already refused to redraw over a field somebody was editing; this is that rule
for every surface.

**Where this is not qualified.** The bound and the hold are measured in
`read-chase.test.mjs` against a clock the test controls. That the whole thing holds under a
real agent is owner-observed and measured by a task-owned harness rather than by a lane
that runs on its own: 254 rounds, about 50,800 records and twenty minutes of continuous
writes with the front page open and the owner switching views throughout, against a build
that died at round 160. Falsifying the bound does not produce a failing assertion — the
suite stops returning, which is the defect itself — so the tests cap their own loops to
report a count rather than hang a run.

## 2026-09-15 amendment — a view failure is written down

Accepted by the owner on 2026-09-15, after the app view stopped responding twice in one
day and left nothing behind but a screenshot. The host already detects it — `ProcessFailed`
raises the recovery panel, and the tray notifies a person whose window is out of sight —
but detection that is not recorded is gone the moment the view restarts, which is exactly
when somebody restarts it.

The host now keeps one device-local line per failure, in `view-failures.jsonl` beside the
other device state: the `ProcessFailedKind` as given, how long the view had been up,
whether the window was out of sight at that moment, and what Windows says about free
physical memory and memory load. The last is there because it is the contested reading:
both failures were preceded by the renderer being told memory was critical while the
machine had gigabytes free, and nothing kept which of those two was true.

**Bounds, and why this is not a logging framework.** One file, one line per event, the
newest fifty kept and the rest dropped. No file path, no application or instance identity,
no record contents — the same line the saved diagnostics report already draws. Nothing
leaves the device, and nothing is written into the `.nendo` file: a file carries what an
application is, not what one machine's WebView did on a Tuesday. It fails soft, because a
diagnostic that could stop the app from starting would be a worse defect than the one it
exists to catch.

**It records by default, and the tray switches it off.** The default is the decision worth
defending: a rare failure that costs a person their window cannot be captured by asking
them to have enabled recording beforehand, which is asking them to have predicted it. The
notification-area menu carries "Record view failures" beside the close-button switch, one
click, checked when it is on, and the choice is remembered. A device that chose its close
behaviour before this existed never chose about recording, so it gets the default rather
than an off it never asked for.

**Where this is not qualified.** That the record is written when a real renderer fails is
not covered by an automated lane: nothing scriptable makes WebView2 hang on demand, and
the gate that drives a real window cannot make one stop responding. What is measured is
the record itself — the cap, the round trip, an unreadable line surviving, the default and
its persistence — in `DesktopViewFailureLogTests`. The path from a live `ProcessFailed` to
a written line is wired but unexercised, and the next occurrence is what will exercise it.

## Consequences

### Positive

- Studio and semantic surfaces share one renderer, theme, accessibility model,
  automation model and editor vocabulary.
- The host remains the sole authority and can outlive/restart the renderer.
- A mature web grid can be evaluated without creating a second normal UI stack.
- The renderer is replaceable behind Nendo-owned semantic and service contracts.

### Negative

- Windows accessibility and keyboard quality depend on WebView2 integration and
  must pass DS2 rather than being assumed from browser behavior.
- The runtime uses a host plus a WebView2 process family and had roughly 601 MB
  aggregate Debug working set in the single EX-0003 observation.
- A full renderer failure temporarily removes every normal surface, leaving only
  bounded native recovery until restart.
- A resident host keeps the WebView2 process family alive behind a hidden window,
  so the working set above is now also the cost of a window somebody thought they
  had closed.
- Closing the window is no longer a way to end agent access; see the 2026-09-15
  amendment.
- The product carries both .NET/Windows App SDK and web asset/tooling concerns,
  even though it has only one normal UI implementation.

## Rejected alternatives

A is rejected because its native Windows benefits did not justify duplicated
normal UI and the cross-boundary maintenance surface. C is rejected because its
single-process recovery and unqualified grid path are poor fits for permanent
Studio, despite its lower idle process count and potential portability.

Neither rejection is a claim that WinUI controls or Avalonia are generally
inferior. It is a decision for Nendo's recorded constraints and evidence.

## Revisit triggers

- DS1 cannot produce a credible Studio table in the selected workbench.
- DS2 finds a material WebView2 focus, accessibility, scaling or lifecycle
  failure that cannot be bounded without a second normal UI stack.
- WebView2 or Windows App SDK deployment becomes incompatible with Nendo's
  offline/portable requirements.
- A mature native grid demonstrates equivalent product quality and materially
  lower total system cost.
- Cross-platform delivery becomes an explicit product requirement with funded
  validation rather than an architectural option value.
