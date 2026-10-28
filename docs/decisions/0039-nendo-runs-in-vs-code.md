# ADR-0039: Nendo runs in VS Code

- **Status:** Proposed
- **Date:** 2026-10-28
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Low
- **Evidence:** Pending. No prototype yet
- **Amends:** ADR-0002 (a third host), ADR-0013 (views in VS Code webviews), ADR-0036 (the browser build in a second runtime), ADR-0038 (where a device setting is kept)
- **Depends on:** ADR-0002, ADR-0005, ADR-0009, ADR-0013, ADR-0014, ADR-0036, ADR-0038

## Context

Nendo has two hosts: the WinUI Desktop and the browser page
([ADR-0036](0036-nendo-runs-in-a-browser.md)). Both draw their own shell around the
Workbench: the title band, tabs, the navigation rail, the address row, the command box,
dialogs, notices and the status line. Desktop adds the notification area, Windows
notifications, the taskbar, the Jump List and tab windows.

VS Code already has each of those: editor tabs and groups, floating windows, an activity
bar with tree views, a command palette, quick picks, source control with a diff editor, a
Problems panel, notifications, a status bar, a settings editor, colour themes and a chat
that consumes MCP servers. People who work in VS Code would open a `.nendo` file there
rather than install and switch to another program.

A VS Code extension is JavaScript running in VS Code's extension host: Node on the desktop,
a web worker in VS Code for the Web. It installs from a `.vsix` with nothing else on the
machine. Node cannot run the C# Engine directly, but it runs WebAssembly, and the Engine
already builds for `browser-wasm` with SQLite linked in (ADR-0036). .NET's WebAssembly
runtime runs under Node as well as in a browser.

## Decision

The leading hypothesis. Nothing here is decided until the owner accepts it.

Nendo has a VS Code host beside Desktop and the browser host. It is an extension and
nothing else: no program of its own, no .NET install. It uses VS Code's own UI wherever VS
Code has the element, and webviews only for what VS Code cannot draw: the Studio grid,
compiled screens, charts and custom views.

### The Engine runs on WebAssembly inside the extension

- The extension carries the browser host's build: the .NET runtime, the Engine and
  `Nendo.Session` on WebAssembly, exporting the bridge's one JSON method, protocol version 7,
  and the open file's bytes (ADR-0036). One Engine for all three hosts.
- Each open file runs in its own worker (`worker_threads` in Node, a web worker on the web),
  so a long read or a proposal's validation never blocks the extension host, which every
  other extension shares.
- The file is read through `workspace.fs` into the runtime's in-memory file system and
  opened there. After each answer that changed it, the extension writes the whole file back
  through `workspace.fs`, as the browser host does with a picked file. A file opens up to
  256 MiB.
- The host's own methods are partials, as in ADR-0036. The VS Code build implements
  downloads and the access level. It refuses tab windows, tab drags, native diagnostics and
  `agentSession.*` with `not-in-this-host`.
- The extension (`Nendo.Code`, TypeScript, bundled with esbuild) holds no Engine logic. It
  loads the runtime, routes each webview's requests to its file's worker, and draws the
  native UI below from bridge reads.

### Native UI wherever VS Code has it

| Desktop or Workbench element | In VS Code |
| --- | --- |
| Opening a `.nendo` file, *Open with*, dropping a file | A custom editor for `*.nendo`; the explorer, *Open With…* and a drop onto the window open it |
| New file, Duplicate, Fork, Backup, Restore | Commands, with `showSaveDialog` and `showOpenDialog` |
| Navigation rail: front page, record types, screens, views | A **Nendo** view container in the activity bar, with a tree per file |
| Studio: Data, Structure, Screens, History, Health | Fixed nodes at the top of that tree that no application content can remove. Data opens the grid in a webview; Structure and Screens are trees with inline actions; History is a tree of revisions with *Undo* as an action |
| Health and compiler diagnostics (`NUIxxx`) | The Problems panel, through a diagnostic collection on the file's URI |
| Tabs, the trail, Back and Forward | Editor tabs, one per place; VS Code's own navigation history |
| Tab windows and tab drags | Editor groups, split editors and floating windows, which VS Code provides |
| Title band, Mica, the Nendo logo treatment | VS Code's title bar. The logo is the extension's icon |
| Command box and Ctrl K | Commands in the command palette; *Go to record* is a quick pick over `records.search` |
| Waiting proposals and review | A source control provider: each proposal is a group, each changed entity, node or package file a resource. Clicking one opens VS Code's diff editor over a read-only text rendering of the semantic diff, and a view package's files as code. **Accept** is the provider's action and calls the same reviewed-digest promotion |
| Settings on this computer | VS Code settings (`contributes.configuration`), in the settings editor |
| Settings for this file here, and in the file | A Settings webview, as the Workbench draws them now |
| Notices and Windows notifications | `showInformationMessage` and `showWarningMessage`. They route and never grant, as in Desktop |
| Status line, busy pill, agent access level, read-only lock | Status bar items; the access level opens a quick pick, and Unattended asks in a modal |
| Waiting-on-approval badge | A badge on the Nendo view container |
| Confirmations | Modal `showWarningMessage` |
| Help, and a file's own help pages | VS Code's Markdown preview over a read-only document, and a walkthrough for the first open |
| Theme: System, Light, Dark | VS Code's colour theme. Webviews map `02-tokens.css` onto VS Code's theme variables and also meet high contrast |
| Recovery and safe mode | If a file's worker fails, its editors show a recovery page with *Restart* and *Restart without custom views*; Studio's tree stays |

### Webviews draw what VS Code cannot

- The Workbench builds a VS Code entry point that renders one place with no shell: no rail,
  tabs, title band, address row or status line. Its client, `host-vscode.ts`, carries the
  bridge over the webview's `postMessage` to the extension and on to the file's worker.
- The Studio grid stays AG Grid. Record pages, lists, boards, calendars, timelines,
  galleries, matrices, outlines and the overview are the Workbench's markup in a webview
  each.
- The file's pictures are read from the file and handed to the webview as data, as the
  browser host does; `nendo-media://` addresses are never fetched.

### Custom views get webviews of their own

- Each shown view is its own webview panel or webview view. Its package's files are written
  to a content cache in the extension's storage, keyed by SHA-256 as in Desktop, and loaded
  through `asWebviewUri`.
- `window.nendo` keeps its closed method table. The broker moves from the Workbench page to
  the extension, which checks each request before passing it to the file's worker.
- A view's toolbar controls become editor title actions and commands, and its keys become
  keybindings scoped to that view.

### Agents use VS Code's chat

- On the desktop, the extension serves each open file's MCP endpoint on its loopback port
  with Node's `http`, from the same port store as Desktop, so a registered agent finds the
  file at the same address in either host. The tools and resources stay LocalMcp's: its
  handlers are built into the WebAssembly runtime without Kestrel, and the extension hands
  each JSON-RPC message to them. Host and Origin checks stay as ADR-0009 states them.
- The extension registers that address with VS Code (`registerMcpServerDefinitionProvider`),
  so VS Code's chat, and any agent extension that reads VS Code's MCP servers, finds it with
  no configuration.
- VS Code for the Web cannot listen on a port, so there it has no agent access, as in the
  browser host.
- There is no Agent page and no launched agent: VS Code's chat and the person's agent
  extensions take that place. `nendo.assistant` is refused, because answering it through
  VS Code's language model API would put a model client in the host
  ([ADR-0014](0014-drop-embedded-agent-mcp-is-the-agent-surface.md)).

### What the VS Code host does not do

- No notification area, taskbar badge, Jump List, per-file icon or shell registration.
- Nothing outlives the window. Closing VS Code ends each file's worker, its MCP endpoint and
  its leases, where Desktop keeps the file open in the notification area.

### Delivery

- `tools/Build-CodeExtension.ps1` packs the extension, the Workbench's VS Code entry point and
  the WebAssembly runtime into one `.vsix` for every platform, since nothing in it is native.
- The owner installs it with `code --install-extension`. Publishing to the Marketplace is a
  separate, owner-approved step.
- A lane drives a real VS Code with `@vscode/test-electron` against a task-owned copy of a
  file: open, edit a record, validate and accept a proposal, show a custom view, connect over
  MCP, reopen.

### Still undecided

1. **The same file open in Desktop and VS Code.** The VS Code host holds the file in memory
   and writes it back whole, with no SQLite lock on the real file. The leading choice is that
   the extension writes Desktop's write-owner sidecar beside the file and honours one Desktop
   wrote, so each host offers the other's open file read-only. Whether a write-back is
   atomic through `workspace.fs` on Windows has to be measured.
2. **LocalMcp on WebAssembly.** Whether the MCP SDK's server and LocalMcp's handlers build for
   `browser-wasm` without ASP.NET Core has to be measured. If not, the MCP endpoint is
   TypeScript over the bridge, which is a second implementation of the tool surface.
3. **Where device state lives.** Sharing Desktop's `%LOCALAPPDATA%\Nendo` keeps one set of
   behaviour approvals, view switches and ports per device, but the WebAssembly runtime
   reaches it only through the extension. The extension's own global storage keeps the hosts
   apart and works on the web.
4. **Settings on this computer.** VS Code's settings editor is the native home, but
   [ADR-0038](0038-settings-in-one-place.md) keeps every setting on one Settings page. The
   leading choice is VS Code settings for this computer, with the Settings webview linking
   to them.
5. **A view's page storage and process.** Views keep drafts in page storage, and in Desktop
   each view has its own origin and renderer process. Whether a VS Code webview's storage
   survives a reload, keeps two views apart, and runs in its own process has to be measured,
   and what it does not give recorded as what this host gives up.
6. **Whether `nendo.assistant` reaches VS Code's chat**, as a chat participant that hands the
   view's message to the chat the person is using, without a model call of its own.

## Consequences

### Positive

- A `.nendo` file opens in VS Code from one `.vsix`, on Windows, macOS and Linux, and in VS
  Code for the Web, with nothing else installed.
- Editor tabs, splits, floating windows, the palette and themes come from VS Code.
- Proposals are reviewed in VS Code's diff editor, which suits a custom view's code best.
- Agent access needs no configuration for VS Code's chat.
- The same Engine and `Nendo.Session` as the other hosts, and the browser host's build
  reused rather than a third.

### Negative

- A third host and a second shell. Each new Workbench screen needs a decision about its
  native form in VS Code, and a lane.
- The tree, source control, status bar and command code is new TypeScript that neither other
  host has.
- Every place in its own webview costs a renderer and the Workbench's start; a grid and two
  record pages are three page loads.
- The Engine is interpreted WebAssembly, single-threaded per file, slower than Desktop's, and
  bounded by the worker's memory, which a file, a proposal clone and a backup share.
- The file is written back whole after each change, and nothing holds a lock on it while it
  is open.
- VS Code's extension API changes monthly. Timeline, used for History in VS Code's own
  explorer, is a proposed API that a published extension cannot use.
- Nothing stays resident: an agent working on the file stops when VS Code closes.

## Rejected alternatives

- **A native .NET program the extension starts:** native SQLite and LocalMcp unchanged, but a
  separate program to ship per platform is what an extension is meant to avoid.
- **An Engine in TypeScript over a Node SQLite module:** a second implementation of the query
  rules, the formula language and automatic actions, which ADR-0036 already rejected.
- **The whole Workbench in one webview:** the least work, but it draws Nendo's own shell
  inside VS Code's and uses none of what VS Code offers.
- **The Engine on the extension host's own thread:** one long validation would stall every
  extension in the window.
- **Using VS Code's language model API for `nendo.assistant`:** a model client in the host.

## Revisit triggers

- The Timeline API becomes stable.
- VS Code webviews gain a way to answer their own resource requests, which would let a view
  keep its `.example` origin.
- .NET's WebAssembly runtime gains threads without cross-origin isolation.
- VS Code's MCP registration API changes its shape.
