# ADR-0036: Nendo runs in a browser

- **Status:** Accepted
- **Date:** 2026-10-26
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium-low
- **Evidence:** Pending. Two prototypes: the .NET 10 runtime booted from one HTML page opened from `file://` and answered a JSON request (`prototypes/browser-host/`); a view package ran in an opaque-origin frame through the Workbench's broker
- **Amends:** ADR-0001 (where a file can run), ADR-0002 (a second host), ADR-0013 (views in a browser)
- **Depends on:** ADR-0001, ADR-0005, ADR-0007, ADR-0008, ADR-0010, ADR-0013

## Context

Nendo runs only as the installed Windows host. A `.nendo` file is portable; the program that
opens it is not. Someone on macOS, Linux or a Chromebook, or someone who will not install a
program, cannot use an application they are sent.

The Engine is a plain `net10.0` library over SQLite and NCalc. It has no threads, no blocking
waits and no compiled expressions. Three of its types call Windows directly: file identity,
the instance guard and the verified move. The Workbench's request protocol is answered by code
in the Desktop project, most of which is plain .NET.

.NET 10 runs in a browser on WebAssembly, single-threaded, with an in-memory file system.
SQLite's emscripten build ships in the SQLite package Nendo already uses. A prototype booted the
runtime from one HTML page opened from disk, with every runtime file inside the page.

A second implementation of the query rules, the formula language and automatic actions in
TypeScript would drift from the Engine. Running the Engine itself avoids that.

## Decision

Nendo has a browser host: the same Engine and the same Workbench, running in a browser page
with nothing installed.

### One Engine, compiled for the browser

- The Engine is built for `browser-wasm` from the same source. Calculations, automatic actions,
  proposals, history and compensation behave as in the Windows host.
- The three Windows-only types sit behind an internal platform seam with a Windows and a
  browser implementation, chosen at run time. In the browser: a file's identity is its path in
  the page's file system, the instance guard is in-process, and a verified move is a move
  followed by the digest check the Engine already makes.
- The Engine never waits synchronously. A browser has one thread, and a blocking wait there
  throws. The production gate refuses `.Wait(`, `GetAwaiter().GetResult()`, `Task.WaitAll`,
  `Task.WaitAny`, `Thread.Sleep` and `new Thread` under `src/Nendo.Engine`.
- SQLite keeps its profile (rollback journal, `synchronous=FULL`). The browser's in-memory file
  system makes `fsync` free and file locks no-ops; the single-writer rule is kept by the page,
  below.

### Projects

- `Nendo.Session` (`net10.0`) holds the Workbench protocol handler and the session controller's
  reads, writes, proposals, extension state, help and media. Desktop and the browser host both
  use it. Window, tab, title-bar, download, agent and launched-agent methods stay in Desktop,
  which adds them through an extension point on the handler's dispatch.
- `Nendo.Browser` (`Microsoft.NET.Sdk.WebAssembly`, `net10.0`, `browser-wasm`) references the
  Engine and `Nendo.Session`. It exports one JSON request method, the same protocol the WebView2
  bridge carries, and the file's open and save.
- The Workbench gains a browser client (`host-wasm.ts`) beside the Desktop and preview clients.
- Device state the Windows host keeps in its device folders (behaviour approvals, view switches,
  appearance) is kept in the browser's IndexedDB for the page's origin.

### Files in the browser

- The person opens a `.nendo` file with the browser's file picker, or by dropping it on the page.
  Its bytes are written to the in-memory file system and opened there.
- Where the browser can write a file the person picked (the File System Access API, in
  Chromium-based browsers), the host writes the whole file back after each committed revision,
  when no transaction is open. The browser replaces the file atomically when the write closes.
- Elsewhere, the page says the file is held in this page only, and **Download** saves a copy.
- One page writes a file at a time. A second page opening the same application instance opens
  it read-only (the Web Locks API, keyed by application and instance ID).
- The browser host opens files up to 256 MiB, and names the size when it refuses one. The file,
  a proposal clone and a backup share one WebAssembly memory.

### What the browser host does not do

- No agent access: there is no MCP endpoint and no launched agent. Agent methods are refused by
  name.
- No sync-managed-location warning, recent-file list across devices, tabs in windows, or title
  bar integration.
- Custom views run as in [ADR-0035](0035-an-app-exported-as-one-web-page.md): opaque-origin
  frames, with the package loaded by the page.

### Delivery

- The browser host builds as one self-contained HTML page: the Workbench, the .NET runtime and
  the Engine, each file embedded and handed to the runtime through its resource loader, so the
  page opens from disk with no server. The same build can be published as a static site.
- An exported application ([ADR-0035](0035-an-app-exported-as-one-web-page.md)) is this page
  with the file inside it.
- Where the hosted page is published is a separate, owner-approved step.

## Consequences

### Positive

- A file runs anywhere a current browser does, with its calculations, actions, Studio and views.
- One Engine: no second implementation of the query rules or the formula language to keep in
  step.
- The protocol code Desktop and the browser share moves into a project with no Windows target,
  which also makes it testable without WinUI.

### Negative

- The page carries the .NET runtime: several MB, against a few hundred KB for a page of data.
- The loader leans on the runtime's resource-loader hook, which `dotnet.d.ts` marks as not a
  public API with compatibility guarantees. A .NET upgrade must re-run the browser lane.
- Building needs the `wasm-tools` workload, which links SQLite into the runtime.
- Without the File System Access API, a person's work lives in the page until they download it.
- A file's size is bounded by browser memory.

## Rejected alternatives

- **A static client over a snapshot:** a second implementation of the query rules, with frozen
  calculations and no automatic actions.
- **The official sqlite-wasm build on OPFS in a worker:** durable without a save step, but it
  replaces Microsoft.Data.Sqlite under the Engine and needs a worker and a server.
- **Multithreaded WebAssembly:** needs cross-origin isolation headers, which a page opened from
  disk cannot send.
- **Ahead-of-time compilation:** two to three times the download for speed the Engine does not
  need.

## Revisit triggers

- The runtime's resource loader changes or disappears in a .NET release.
- Browsers without the File System Access API gain a way to write back a picked file.
- A browser standard lets a page reach an agent (WebMCP), and the browser host should offer one.
- Files above 256 MiB need to open in a browser.
