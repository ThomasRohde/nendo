# ADR-0002: Select the containing desktop architecture and process model

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0002 result and EX-0003 result
- **Depends on:** EX-0001 typed kernel services and the EX-0002 host-neutral semantic plan
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Nendo needs a permanent Studio/recovery route, rich table/editor mechanics, and
compiled semantic forms and boards. It must also keep one portable `.nendo` file
and host-owned authority. One primary maintainer must be able to maintain the
containing choice. The choice must not expose storage or generic privileged calls
to a renderer.

EX-0003 compared real WinUI-plus-island, one-web-workbench and Avalonia stacks
against the same real fixture and typed contract. Alternative B scored 88/100.
C scored 72 and A scored 71. B kept real renderer-failure recovery and needed the
least candidate-specific normal-UI code.

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

A has the strongest native Windows surface and the smallest failure blast radius.
But it needs two normal renderers for selection, themes, forms, boards,
inspectors, editors and automation. The experiment measured the largest
candidate source and the same seven-process WebView2 runtime tree as B.

### B — thin WinUI host with one local web workbench

One WebView2 renderer owns all normal Studio and semantic surfaces. WinUI owns
only the desktop lifecycle and a bounded native recovery/safe-mode surface. B has
the clearest mature-grid path and the smallest normal-UI duplication. It also
keeps a real renderer process boundary.

### C — one Avalonia native/cross-platform stack

C has one in-process renderer and the lowest idle process count. It also has no
renderer failure isolation and a broad restored native-asset graph. It showed
weaker Windows automation behavior, and it has no qualified native grid path for
DS1.

### Defer

Deferral would block DS1. It would also encourage production UI work to choose
an architecture because of component or prototype momentum.

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
- a bounded native host surface stays available when the renderer cannot start
  or has failed. It may inspect health, list bounded recovery data and
  restart/repair the renderer. It is not a second normal editor stack;
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
mutation/replay/conflict behavior, Light/Dark/System propagation and real
WebView2 crash recovery. Its result records the exact packages, commands,
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

DS1 and DS2 then produced the required functional, provider, focus,
high-contrast, packaging and lifecycle evidence. DS2 remains **revise** because
nobody observed a real 200% Windows scale. Repository owner Thomas Klok Rohde
deferred that check to post-selection, pre-release hardening, and accepted
ADR-0015 at Medium confidence. This is not a 200% pass. A material scaling,
accessibility, focus or recovery failure reopens ADR-0015 and this containing
decision.

## 2026-09-15 amendment — the host outlives its window

The original decision gave the host "the desktop window, title-bar and operating-
system integration". It made window lifetime and process lifetime the same thing.
They are now separate.

**What changes.** The close button hides the window into the notification area.
The process stays resident with its file open, its Engine alive and its MCP host
listening. The tray icon's menu carries the real exit, a readout of the current
agent access mode, a control to turn that access off, and a toggle that makes the
close button exit again. The preference is device state under the per-user root,
and its default is the notification area. The process owner can pin it with
`NENDO_DESKTOP_CLOSE_ACTION`. The scripted window lanes use this variable because
none of them can click a tray menu. Nendo is multi-instance and each window holds
a different file, so there is one icon per window.

The host also gains a notification surface. It raises Windows notifications for
the states that need a person, and only while the window is hidden or minimised.
There are four states:

- a validated proposal is waiting;
- a file's automatic actions need consent;
- the open file stopped being writable;
- the workspace failed.

Routing them needs the first unsolicited message on the Workbench bridge, which
is bridge protocol version 7. A renderer at 2–6 drops it, as it always dropped a
message without a request id.

**Notifications route; they never grant.** A notification may say that a person
is needed and open the page where they answer. It may not carry the answer.
Acceptance of a proposal depends on promotion verifying the digest that the
person reviewed ([ADR-0007](0007-proposal-clone-validation-and-replay-promotion.md)).
Consent binds an exact digest, contract version, definition revision and
capability set ([ADR-0008](0008-general-scripting-and-capability-isolation.md)).
A notification cannot show either of these, so a person may not answer either
from a notification. Also, anyone at the machine can click a notification.
`Test-Production.ps1` keeps the notification types out of the MCP adapter in the
same way that it keeps approval out. A test asserts that no notification payload
carries an approve, accept, promote or grant argument.

**What this costs.**
[ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md) records that
while a file is open with access on, any process on this machine can connect at
that access level. Before this amendment, the owner could close the window to
turn that off, because closing the window closed the file. That is no longer
true: a window that looks shut can be a process that still serves MCP. This is
the intended behaviour, because the purpose is an agent that works while nobody
watches. But it makes the ADR-0009 posture apply for a longer interval. This
amendment changes nothing else about that posture. This amendment takes these
measures:

- the tray menu shows the live access mode and offers to turn it off;
- the tooltip names the open file and shows when it is waiting on approval;
- the first close on a device explains where the window went.

This amendment does *not* add a new credential or peer check. ADR-0009 calls
that check the route back, and it is still not built.

**Where this is not qualified.** The notification-area icon, its menu and the
notifications are owner-reported. `tools/Review-ShellRuntime.ps1` drives a real
window. It checks that closing hides the window, that the process and its file
survive, and that the exit pin still exits. No script can enumerate another
process's tray icon or observe a shell notification. The lane states this in its
own output, and it does not imply coverage that it does not have.

## 2026-09-16 amendment — a screen may not chase its reads without a bound

The app view stopped responding four times in two days. The record from the
amendment below identified it on the fourth time: `RenderProcessUnresponsive`,
the window visible, and 9.7 GB of the machine's memory free. The pressure that
Chromium logged came from inside the renderer, not from Windows.

**What it was.** A surface that draws exact numbers asks for the missing numbers
for the current revision, and redraws when they arrive. That is a loop, and it
stopped only because the answers usually arrived. While an agent wrote, they did
not arrive. The surface issued each read against one change sequence and
discarded it when the file moved. The discard cleared the in-flight marks, so the
next draw found the same tiles missing and asked again. The front page redrew as
fast as the host could answer, and rebuilt the page every time. Then WebView2
declared the renderer unresponsive. The record count had no effect: 125 records
caused it as readily as 33,000. Only an agent that wrote continuously could cause
it. For this reason it started on the day the front page became the screen that
Use opens on.

**The rule.** A screen may not chase its reads without a bound. It runs one pass
at a time, and at most one pass a second. If a pass leaves work outstanding, it
asks to be woken once. It does not redraw into the next pass. `refreshDerived`
already bounded the same chase: it counted attempts and refused the third. This
rule applies the same bound to the reads that are per tile.

**And an answer is not stale because the file moved while it was being read.**
The answer is about the revision that it was read at. It carries that revision,
and the surface keeps it. When the surface discarded such answers, a file under
continuous writes could never show a number: every answer arrived after the file
moved, so the surface discarded every answer. An answer must still not land on
another view or another file. The generation and file-session guards prevent
that. The cost is that while writes continue, tiles on one page can show slightly
different revisions. Each tile is exact for the revision it names, and the tiles
converge when the writes stop.

**Nothing redraws under the person's hands.** These hold the automatic redraws
off: an open menu, a focused control, an open dialog, or any pointer, key or
focus event in the last 750 milliseconds. The first version of this fix honoured
only the open menu. The owner reported that the picker was still "a bit
finicky". A redraw between the pointer going down and the menu opening moves the
target away from the click. The Agent page's poll already refused to redraw over
a field that somebody was editing. This rule applies that behaviour to every
surface.

**Where this is not qualified.** `read-chase.test.mjs` measures the bound and the
hold against a clock that the test controls. Behaviour under a real agent is
owner-observed. A task-owned harness measured it, not a lane that runs on its
own. The harness ran 254 rounds, about 50,800 records and twenty minutes of
continuous writes, with the front page open and the owner switching views
throughout, against a build that died at round 160. When the bound is
falsified, no assertion fails: the suite stops returning, which is the defect
itself. For this reason the tests cap their own loops, so that they report a
count and do not hang a run.

## 2026-09-15 amendment — a view failure is written down

The owner accepted this amendment on 2026-09-15. On that day the app view stopped
responding twice and left nothing behind but a screenshot. The host already
detects the failure: `ProcessFailed` raises the recovery panel, and the tray
notifies a person whose window is out of sight. But if the host does not record
the detection, it is lost when the view restarts, and a person restarts the view
at exactly that moment.

The host now keeps one device-local line per failure, in `view-failures.jsonl`
beside the other device state. The line contains:

- the `ProcessFailedKind` as given;
- how long the view was up;
- whether the window was out of sight at that moment;
- what Windows reports about free physical memory and memory load.

The last item is there because it is the contested reading. Before both failures,
the renderer was told that memory was critical while the machine had gigabytes
free. Nothing kept the data to show which of those two was true.

**Bounds, and why this is not a logging framework.** The host writes one file,
with one line per event. It keeps the newest fifty lines and drops the rest. The
line contains no file path, no application or instance identity and no record
contents. This is the same limit that the saved diagnostics report uses. Nothing
leaves the device, and nothing goes into the `.nendo` file: a file carries what
an application is, not what one machine's WebView did on a Tuesday. The record
fails soft, because a diagnostic that could stop the app from starting would be a
worse defect than the defect it exists to catch.

**It records by default, and the tray switches it off.** The default is the
important choice. A rare failure that costs a person their window cannot be
captured if the person must enable recording first, because that asks them to
predict the failure. The notification-area menu carries "Record view failures"
beside the close-button switch. It is one click, it is checked when it is on,
and Nendo remembers the choice. A device that chose its close behaviour before
this setting existed never made a choice about recording. That device gets the
default, not an off that nobody asked for.

**Where this is not qualified.** No automated lane covers the write of the record
when a real renderer fails. No script can make WebView2 hang on demand, and the
gate that drives a real window cannot make it stop responding.
`DesktopViewFailureLogTests` measures the record itself: the cap, the round trip,
the survival of an unreadable line, the default and its persistence. The path
from a live `ProcessFailed` to a written line is wired but not exercised. The
next occurrence will exercise it.

## 2026-09-17 amendment — a screen is told when the file moves

The owner accepted this amendment on 2026-09-17. The coordinator raises
`Committed` with the change sequence that it reached. The host forwards that
number to the renderer as `fileChanged`, the second member of the closed
unsolicited-event set. The renderer re-reads through the bounded chase of the
2026-09-16 amendment. The full record, with its limits and its recorded outcomes,
is the entry for this date in the [decision index](README.md#amendments-in-force).

## 2026-09-25 note — custom views run as frames of the one WebView2

The Decision above gives every normal surface to one WebView2 workbench. Custom
views now run inside it too
([ADR-0013](0013-custom-views-with-code-in-the-file.md)). Each view is a
cross-origin frame whose code the host serves from the open file, on an origin of
its own under `.example`. Chromium puts each package in a renderer process of its
own, separate from the Workbench's. A view reaches the file only through the
Workbench's broker, which calls the same typed bridge as every other surface. It
is not a second Studio and not a storage authority.

The host keeps the process model's promise that it outlives the renderer: only a
failure of the Workbench's own renderer or of the browser sends the app to
recovery. A view's renderer ending stops that view alone, and the recovery panel
can restart without custom views. The contained helper of 2026-09-20 to
2026-09-24, `Nendo.ExtensionHost`, with its own WebView2 in an AppContainer and a
Job Object, is deleted. The [custom-view contract](../contracts/custom-views.md)
describes the current behaviour.

## Consequences

### Positive

- Studio and semantic surfaces share one renderer, theme, accessibility model,
  automation model and editor vocabulary.
- The host remains the sole authority and can outlive/restart the renderer.
- A mature web grid can be evaluated without creating a second normal UI stack.
- The renderer is replaceable behind Nendo-owned semantic and service contracts.

### Negative

- Windows accessibility and keyboard quality depend on WebView2 integration. They
  must pass DS2; nobody may assume them from browser behavior.
- The runtime uses a host plus a WebView2 process family. The single EX-0003
  observation had roughly 601 MB aggregate Debug working set.
- A full renderer failure temporarily removes every normal surface. Only bounded
  native recovery remains until restart.
- A resident host keeps the WebView2 process family alive behind a hidden window.
  The working set above is now also the cost of a window that somebody thought
  they had closed.
- Closing the window no longer ends agent access; see the 2026-09-15
  amendment.
- The product carries both .NET/Windows App SDK and web asset/tooling concerns,
  but it has only one normal UI implementation.

## Rejected alternatives

A is rejected because its native Windows benefits did not justify duplicated
normal UI and the cross-boundary maintenance surface. C is rejected because its
single-process recovery and unqualified grid path are poor fits for permanent
Studio. This is so although C has a lower idle process count and potential
portability.

Neither rejection claims that WinUI controls or Avalonia are generally inferior.
It is a decision for Nendo's recorded constraints and evidence.

## Revisit triggers

- DS1 cannot produce a credible Studio table in the selected workbench.
- DS2 finds a material WebView2 focus, accessibility, scaling or lifecycle
  failure that cannot be bounded without a second normal UI stack.
- WebView2 or Windows App SDK deployment becomes incompatible with Nendo's
  offline/portable requirements.
- A mature native grid demonstrates equivalent product quality and materially
  lower total system cost.
- Cross-platform delivery becomes an explicit product requirement with funded
  validation, not an architectural option value.
