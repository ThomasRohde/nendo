# ADR-0002: Select the containing desktop architecture and process model

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `WorkbenchProtocolTests`, `WorkbenchAgentSessionProtocolTests`, `DesktopCloseActionTests`, `DesktopTabWindowTests`, `DesktopNotificationContentTests`, `DesktopViewFailureLogTests`, `DesktopAgentFailureLogTests`, `read-chase.test.mjs` and `tools/Review-ShellRuntime.ps1`

## Context

Nendo needs a permanent Studio and recovery route, rich table and editor mechanics,
and compiled semantic surfaces, while keeping one portable `.nendo` file and
host-owned authority. One maintainer must be able to sustain the choice, and no
renderer may receive storage or generic privileged calls.

## Decision

### Host and renderer

- A thin WinUI 3 / Windows App SDK host owns the windows, title bar and operating
  system integration (notification area, notifications, taskbar, Jump List). It owns
  `.nendo` open and close, the Engine, typed application services, revisions,
  validation, write coordination, recovery and the MCP host.
- One local WebView2 Workbench per window owns every normal Studio, form, board,
  inspector and product surface. It is a renderer and a client of typed services,
  never a storage or authority boundary.
- A bounded native recovery surface stays available when the renderer cannot start
  or has failed. It shows health, lists bounded recovery data, restarts or repairs
  the renderer, and offers **Restart without custom views**. It is not a second
  editor stack.
- Web assets are local and offline under a restrictive content-security policy.
- Frameworks, the grid and packaging are decided elsewhere
  ([ADR-0015](0015-host-owned-database-studio-and-ag-grid-community.md),
  [ADR-0017](0017-production-composition-and-build-layout.md)) and may not weaken
  this boundary.

### The bridge

- Renderer requests use a closed, versioned, named message vocabulary with stable
  semantic IDs, optimistic preconditions and idempotency keys. No SQL, SQLite
  connection or type, database or file path, raw filesystem, network or process
  authority, host-object exposure or generic invocation crosses into web content.
- The host serves bridge protocol 7 only. A request at any other version is refused
  as `unsupported-protocol` before anything runs. Host and Workbench ship together,
  so new methods do not change the version.
- Unsolicited host messages are a closed set of events. `fileChanged` carries the
  change sequence the coordinator reached and nothing else: no record contents, no
  description of the change, no notification.
- `data.queryRecordWindow` is Studio's named, cancellable, revision-bound read of a
  record window (open, read, locate) through the existing typed service. Its bounds
  and token are in the [query contract](../contracts/queries.md). It carries no SQL,
  path or write authority and is not exposed to custom-view actors.

### Reads, refresh and redraw

- A screen chases missing reads one pass at a time and at most once a second. A pass
  that leaves work outstanding asks to be woken once; it does not redraw into the
  next pass.
- An answer is about the revision it was read at, carries that revision and is kept
  even if the file moved meanwhile. Generation and file-session guards keep it from
  landing on another view or file. While writes continue, tiles on one page may show
  slightly different revisions; they converge when writes stop.
- The coordinator raises `Committed` for every writer it serves; the host forwards it
  as `fileChanged`. It is a nudge, not a refresh: the renderer re-reads through the
  same bounded chase. A replay commits nothing and announces nothing. The host does
  not resend a missed event. A handler marshals and returns and never waits on a
  coordinator operation. Drafts key on the file session, which a write does not
  change.
- Nothing redraws automatically while a menu, dialog or focused control is open, or
  within 750 ms of a pointer, key or focus event.

### Process and window lifetime

- The close button hides the window into the notification area. The process stays
  resident with its file open, its Engine alive and its MCP host listening. The tray
  menu carries the real exit, the live agent access mode with a control to turn it
  off, a switch that makes the close button exit, and **Record failures**. The
  tooltip names the file and says when it waits on approval; the first close on a
  device explains where the window went. The close preference is device state
  (`window\tray.json`), defaulting to the notification area; `NENDO_DESKTOP_CLOSE_ACTION` (`tray` or
  `exit`) pins it.
- One process holds one file; a second file is a second process.
- A tab dragged out of the tab strip and dropped outside the window, or pulled down
  into the page, opens in a new window of the same process at the drop point, with
  the source window's size. It shares the file's `DesktopSessionController` (Engine,
  file session, agent host, launched agent) and has its own WebView2 and Workbench,
  so its own tabs, trail and drafts. Nothing about the file opens twice.
- The first window is the **main window**. It alone carries the notification-area
  icon, taskbar badge, notifications, Jump List and the file's saved window place. A
  tab window's place is not remembered. A tab window closes when its file session
  ends, hides and shows with the main window, and closing it closes only its tabs.
  Moving a tab does not end a launched agent's conversation.
- `window.detachTab` hands a tab's trail to the host as an opaque string, and
  `window.takeTab` lets the new window take it once; the host never parses a trail.
  Session events (`fileChanged`, `agentActivity`, `agentSessionChanged`,
  `extensionDevelopmentChanged`, `extensionSettingsChanged`) go to every window of
  the file; a notification's route goes to the main window.
- The device-local save journal (`pending-mutations.ts`) keeps one slot per file,
  shared by its windows. A save while another window's is unconfirmed is refused
  unsent.
- Not built: dropping a tab into another window, a window that follows the pointer
  during the drag, and moving tabs between two files' processes.

### Notifications route, never grant

While the window is hidden or minimised, the host raises Windows notifications for
four states: a validated proposal is waiting, a file's automatic actions need
consent, the open file stopped being writable, and the workspace failed. A
notification may open the page where the person answers; it never carries the
answer. Acceptance depends on promotion verifying the digest the person reviewed
([ADR-0007](0007-proposal-clone-validation-and-replay-promotion.md)), and consent
binds an exact digest, contract version, definition revision and capability set
([ADR-0008](0008-general-scripting-and-capability-isolation.md)); neither fits in a
notification, and anyone at the machine can click one. `Test-Production.ps1` keeps
the notification types out of the MCP adapter, and a test asserts that no payload
carries an approve, accept, promote or grant argument.

### Custom views

Each custom view is a cross-origin frame of its window's WebView2, served by the
host from the open file on an origin of its own under `.example`, in a renderer
process apart from the Workbench's. It reaches the file only through the
Workbench's broker and the same typed bridge. A view's renderer ending stops that
view alone; only a failure of the Workbench's renderer or of the browser sends the
app to recovery. See the [custom-view contract](../contracts/custom-views.md).

### Launched-agent conversation

For [ADR-0030](0030-launch-the-persons-own-agent-over-acp.md) the bridge carries
eleven `agentSession.*` methods and the `agentSessionChanged` event (see the
[launched-agents contract](../contracts/launched-agents.md)):

- `list`, `setCommand`, `launch` and `setHidden` take the request gate, like every
  Agent page request.
- `read`, `prompt`, `answer`, `cancel`, `authenticate`, `setOption` and `end` do not,
  so the conversation keeps reading while the agent's own write holds the file. Each
  names its file session and is refused as `stale-file-session` for a closed file.
- All eleven run off the UI thread. A request naming a custom view's actor is
  refused, as on every method except the record writes.
- `prompt` may carry `context`: up to eight `{uri, title, text}` items, `nendo://`
  addresses only, bounded.
- `agentSessionChanged` carries the conversation's revision only. The tab reads what
  changed after the revision it holds and patches those entries in place; it never
  redraws the composer.

### Failure records

- When the app view fails, the host appends one line to `logs\view-failures.jsonl`: the
  `ProcessFailedKind`, how long the view was up, whether the window was out of
  sight, and Windows' free physical memory and memory load.
- When an MCP request fails inside Nendo, the refusal carries a failure reference,
  and `logs\agent-failures.jsonl` gets one line under it: the source (`tool`, `resource`,
  `sdk` or `web server`), the request's name, the exception types from the outermost
  in, and the frames without file names or line numbers. The SDK's and web server's
  warnings and errors reach it by event and exception type. A refusal the agent has
  read and a cancellation are not failures. It records only while the listener
  serves, so a port fallback at start is not recorded.
- Both records are device-local, keep the newest 50 lines and fail soft. A line
  carries no file path, application or instance identity, record contents,
  exception or log message, argument, handle or lease. Nothing leaves the device or
  enters the `.nendo` file. Recording is on by default, because a person cannot
  predict the failure; the tray's **Record failures** switches both off and is read
  at each failure.
- The Desktop tests use a device-state folder of their own (`DesktopTestDeviceState`)
  and never the owner's.

### Not covered by a lane

The notification-area icon, its menu and shell notifications are owner-checked: no
script can enumerate another process's tray icon or observe a notification.
`tools/Review-ShellRuntime.ps1` drives a real window and checks that closing hides
it, that the process and file survive, and that the exit pin exits. The path from a
live `ProcessFailed` to a written line is wired but not exercised, since nothing can
make WebView2 hang on demand.

## Consequences

### Positive

- Studio and semantic surfaces share one renderer, theme, accessibility model,
  automation model and editor vocabulary.
- The host is the sole authority and can outlive and restart the renderer.
- The renderer is replaceable behind Nendo-owned semantic and service contracts.

### Negative

- Windows accessibility and keyboard quality depend on WebView2 integration.
- The runtime is a host plus a WebView2 process family per window, kept alive behind
  a hidden window.
- A full renderer failure removes every normal surface until restart; only the
  native recovery surface remains.
- Closing the window does not end agent access. The
  [ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md) posture applies
  for as long as the process runs; the tray shows and can turn off the access mode.
- The product carries both .NET / Windows App SDK and web tooling, with one normal UI
  implementation.

## Rejected alternatives

- WinUI normal shell with a WebView2 Studio island: two normal renderers for
  selection, themes, forms, editors and automation.
- One Avalonia stack: no renderer failure isolation and no qualified grid path.

## Revisit triggers

- A material WebView2 focus, accessibility, scaling or lifecycle failure cannot be
  bounded without a second normal UI stack.
- WebView2 or Windows App SDK deployment conflicts with offline, portable use.
- A native grid shows equivalent quality at materially lower total cost.
- Cross-platform delivery becomes a funded product requirement.
