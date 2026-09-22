# Authoring a custom view

How to write, package, pin and open a Nendo custom view. The behaviour this guide
depends on is the [custom-view contract](contracts/custom-views.md); where the two
disagree, the contract is the record and the code is current. The authority is
[ADR-0013](decisions/0013-defer-general-extension-model.md), accepted 2026-09-20.

Two worked examples ship in this repository, both MIT-licensed and dependency-free:
[`extensions/dependency-graph/`](../extensions/dependency-graph/README.md), the general
record graph, and [`extensions/work-dependencies/`](../extensions/work-dependencies/README.md),
the planner's own dependency view. Everything below can be read against either.

## What you can build today

One thing: **a renderer for a bounded graph projection**. Protocol 1 gives a package
a read-only list of nodes and edges the person approved, and one suggestion back —
*this record is selected*. That is the whole surface.

A package cannot define storage, read a field nobody disclosed, run a query, open a
file, reach the network, navigate the host, write a record, ask for a new permission
or carry consent. It is not a plugin model, and it is not a step toward one. Anything
outside the graph projection needs an accepted ADR first.

What is yours: the layout, the interaction, the accessibility, the presentation of
labels and one optional status value per node.

## The three separate things

Nothing here implies the next. Each is its own act, with its own refusal:

1. **A package** — signed by nothing, identified by the SHA-256 of its exact archive
   bytes. Installing it grants no permission to run.
2. **A view definition** — durable content in the `.nendo` file that pins a package
   digest and names the fields it may read. Accepting it installs nothing and
   approves nothing.
3. **Device consent** — a native review, keyed to the *physical file* on *this
   device*. A copy of the file inherits nothing. Changing either of the first two
   invalidates it.

## Part 1 — Write the renderer

### Files

Plain HTML, CSS and JavaScript, written as files, with no build step required. Only
`.html`, `.css`, `.js` and `.txt` assets are allowed, and the entry point must be a
declared `.html` asset. Every asset must be valid UTF-8 text; there are no images,
fonts, binaries or source maps, and nothing is fetched at runtime. A package that
wants a library bundles it as another `.js` file, with its license as `.txt`.

### The environment your page runs in

The page is served from the virtual origin `https://nendo.extension.local` inside a
zero-capability AppContainer, in a Job Object with a 512 MiB aggregate memory cap, a
20% CPU cap, at most 32 processes and kill-on-close. Every response carries:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'none'
```

What that costs you, in the order it usually bites:

- **No inline `<script>` and no inline event handlers.** `script-src 'self'` means
  your JavaScript is a separate `.js` asset, wired with `addEventListener`. This is
  the first thing that breaks a page pasted in from elsewhere.
- **No network of any kind.** `fetch`, `XMLHttpRequest`, WebSocket, WebRTC, beacons,
  remote fonts, CDN anything. The AppContainer — not the CSP — is the boundary that
  enforces it; the CSP is defence in depth.
- **No workers, no frames, no plugins, no downloads, no pop-ups.**
- **No clipboard.** `navigator.clipboard` is sealed to `undefined` before your script
  runs, and `document.execCommand('copy'|'cut'|'paste')` returns `false`. The
  person's own Ctrl+C still works on visible text.
- **No `alert`, `confirm`, `prompt`, context menu, developer tools or browser
  accelerator keys.** Debug by drawing to the page.
- **No durable storage.** The browser profile is staged per launch and removed on
  disposal, so `localStorage` does not survive the view closing. Keep state in memory
  and rebuild it from the projection.
- **Inline styles are allowed** (`style-src 'unsafe-inline'`), as are `data:` images.
- **F6 belongs to the host.** It moves focus between your renderer and Nendo's own
  controls, so do not bind it.

Navigation is pinned to the entry point: a second top-level navigation and any frame
navigation are cancelled. Keep it one document — client-side routing that navigates,
and anything that reloads the page, will not survive.

### The message contract

Two directions over `window.chrome.webview`. Every message in both directions carries
`version`, `session` and `generation`; every page message must carry the **exact** key
set for its method — an extra, missing or duplicate key is refused, and a bad frame
still spends your message budget.

**Host → page** (arrives as `event.data` on the `message` event):

| Method | Keys | When |
| --- | --- | --- |
| `initialize` | `version`, `method`, `session`, `generation`, `theme`, `locale`, `projection` | Once, at open |
| `replaceProjection` | `version`, `method`, `session`, `generation`, `projection` | The data changed; `generation` increments and host selection is cleared |
| `setTheme` | `version`, `method`, `session`, `generation`, `theme` | The person changed theme |

`theme` is `"light"` or `"dark"` — use it rather than `prefers-color-scheme`, which
does not follow Nendo's own preference. The host also sends transport-level `dispose`
and `focus` messages that the helper consumes; they never reach your page.

**Page → host** (`window.chrome.webview.postMessage(...)`):

| Method | Extra keys | Rules |
| --- | --- | --- |
| `ready` | — | Must arrive **within five seconds** of the session starting, exactly once, before anything else |
| `selectRecord` | `recordId` | The ID must be a node in the **current** projection |
| `reportError` | `code`, `message` | `code` is `render-failed` or `unsupported-projection`; `message` is at most 1024 characters of plain text |

`reportError` text is shown as prose. It is never a command, a navigation target or
telemetry, and clears the host's selection.

Hard limits: **64 KiB** per frame (refused before parsing), **60 messages per rolling
second** (flooding closes the session), maximum JSON depth 8, strict UTF-8. The helper
queues at most 16 outbound frames, so a burst from an animation loop is a way to lose
the view — send on the interaction, not on the frame.

`selectRecord` is a *suggestion*. It updates host-owned selection and nothing else.
Opening the record is a native control the person clicks; package JavaScript cannot
forge that gesture.

### The projection

```json
{
  "sourceChangeSequence": 41,
  "nodes": [{"id": "rec-a", "label": "Engine", "status": "Doing"}],
  "edges": [{"id": "rec-1", "sourceId": "rec-a", "targetId": "rec-b"}]
}
```

- `status` is present and `null` when no status field is bound — test for both `null`
  and `undefined`.
- Node IDs and edge IDs are semantic record IDs from two different record types, in
  separate namespaces; the same string may legitimately appear as both.
- Bounds: at most 500 nodes, 1,000 edges and 1 MiB serialized; labels and status text
  at most 4,096 characters each. An over-limit graph is refused whole — there is no
  paging and no silent truncation, so you never have to handle a partial graph.
- Cycles, self-links, parallel edges and isolated nodes are all valid and all reach
  you. Lay them out deterministically.
- Numbers arrive as exact text, dates as ISO text. A null label falls back to the
  record ID.

### A minimal renderer

`index.html`:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>My view</title><link rel="stylesheet" href="view.css"></head>
<body><h1 id="summary">Waiting for your records…</h1><ul id="records"></ul>
<script src="view.js"></script></body>
</html>
```

`view.js`:

```js
(() => {
  'use strict';
  let session = null, generation = 0;
  const send = (method, values = {}) => {
    if (session !== null) window.chrome.webview.postMessage({ version: 1, session, generation, method, ...values });
  };
  function render({ nodes, edges }) {
    document.getElementById('summary').textContent =
      `${nodes.length} record${nodes.length === 1 ? '' : 's'} · ` +
      `${edges.length} connection${edges.length === 1 ? '' : 's'}`;
    const list = document.getElementById('records');
    list.replaceChildren();
    for (const node of nodes) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button';
      button.textContent = node.label;              // textContent, never innerHTML
      button.addEventListener('click', () => send('selectRecord', { recordId: node.id }));
      item.append(button); list.append(item);
    }
  }
  window.chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (message.version !== 1) return;
    try {
      if (message.method === 'initialize' && session === null) {
        session = message.session; generation = message.generation;
        document.documentElement.dataset.theme = message.theme;
        document.documentElement.lang = message.locale || 'en';
        render(message.projection);
        send('ready');                               // within five seconds
      } else if (message.session === session && message.method === 'replaceProjection'
                 && message.generation > generation) {
        generation = message.generation; render(message.projection);
      } else if (message.session === session && message.method === 'setTheme') {
        document.documentElement.dataset.theme = message.theme;
      }
    } catch {
      send('reportError', { code: 'render-failed', message: 'The view could not be displayed.' });
    }
  });
})();
```

### What a good renderer owes the person

These are not style notes. Each one is a defect that reached the owner or a gate:

- **Labels are text.** Assign with `textContent`. A record whose label looks like
  markup must render as characters, never as elements.
- **Fit after the layout exists.** The pane is composed and sized by the host *after*
  the page loads, and on a maximized window it may never resize again. A fit computed
  against a zero-sized element pushes every node off-screen and the view looks empty.
  Skip a fit when the element measures under a pixel, then re-fit on the next two
  animation frames, on `resize` and from a `ResizeObserver`.
- **Chrome does not select.** Set `user-select: none` on headings, toolbars, hints,
  footers and the canvas so a drag pans instead of highlighting prose; leave any text
  alternative selectable.
- **Keyboard and focus.** Everything reachable by pointer is reachable by Tab and
  arrow keys, with a visible focus ring, and a keyboard target is scrolled fully into
  view. Do not move a node between pointer-down and click — pointer focus that
  recentres selects the wrong record.
- **A text alternative.** Dense graphs and screen readers both need the relationships
  as a list.
- **Small windows.** The pane opens at half the window and never goes below 480 DIPs,
  but the person can drag the boundary from there, so treat the width as theirs. At
  200% scaling 480 DIPs is roughly a 512×384 CSS-pixel viewport; every control must
  stay in bounds there.
- **Both themes**, driven by `initialize` and `setTheme`.
- **Stay inside the budget.** 512 MiB and 20% CPU are shared by the whole contained
  tree, and exceeding memory stops the view with `memory-pressure` while the file
  stays editable in Studio.

### Choosing the colours

A package owns its palette, and nothing decides it for you. The host sends one word —
`theme` is `"light"` or `"dark"`, on `initialize` and again on `setTheme` — and no
colour crosses the boundary. `prefers-color-scheme` is not an alternative: it follows
Windows, not Nendo's own preference, so a person who has picked Light inside Nendo on
a dark device would get a dark view. Drive both themes from the message.

**A view sits with the app.** It opens in a pane beside Nendo's own chrome — the File
menu, the theme switch, the host toolbar are all inches away — and a palette of its own
reads as a foreign window bolted into the product, whatever its merits on its own. Match
these, current at the time of writing:

| | Light | Dark |
| --- | --- | --- |
| Page behind everything (`--canvas`) | `#f4f5f7` | `#071725` |
| A raised card (`--surface-raised`) | `#ffffff` | `#0e2435` |
| Text (`--ink`) | `#13213d` | `#edf3ff` |
| Secondary text (`--muted`) | `#667085` | `#a8b5c8` |
| Hairlines (`--line`) | `#d9dde6` | `#263e50` |
| Accent (`--cobalt`) | `#2458e6` | `#6597ff` |
| The pane chrome around your viewport | `#f7f8fb` | `#0a1c2b` |

The full set, including the eight choice tones a status may carry, is
[`src/Nendo.Workbench/src/styles/02-tokens.css`](../src/Nendo.Workbench/src/styles/02-tokens.css);
copy the ones you need into your own `:root` and `:root[data-theme="dark"]`. A status
drawn in the same hue the app gives that tone is the same status, which is most of what
matching buys.

These are the Workbench's values today, not a contract. They are not delivered to the
package and nothing tells a view when they change, so a copy can drift out of step with
the app it was matching. Copy them with that in mind, keep the copy in one block at the
top of your stylesheet where it can be compared, and keep your own contrast: neither
theme may lose hierarchy, focus or status meaning.

`systems-lens` follows this. `dependency-graph` and `work-dependencies` predate it and
still carry their own warm palette; changing theirs would change their digests, so it
waits for a reason to rebuild them rather than being done to tidy up.

Changing a stylesheet changes the package digest. A file already
pinned to the old archive reports the package as changed and the view stays shut until
the package is reinstalled and allowed again — the same consequence a behaviour change
has, because the bytes are what consent was given for.

## Part 2 — Package it

A package is a ZIP archive named `*.nendoview` containing `manifest.json` plus exactly
the assets it declares.

### The manifest

All eight keys are required, and any unknown or duplicate key is refused:

```json
{
  "manifestVersion": 1,
  "packageId": "org.example.my-view",
  "version": "0.1.0",
  "protocolVersion": 1,
  "entryPoint": "index.html",
  "capabilities": ["projection.read", "record.select"],
  "license": "MIT",
  "assets": [
    {"path": "index.html", "bytes": 512, "sha256": "<64 lowercase hex characters>"}
  ]
}
```

| Key | Rule |
| --- | --- |
| `manifestVersion` | Exactly `1` |
| `packageId` | Lowercase reverse-domain, at least two dot-separated segments, each starting `a`–`z` and containing only `a`–`z`, `0`–`9` and `-`; at most 200 characters |
| `version` | Exact SemVer, at most 64 characters; numeric prerelease identifiers may not have leading zeros |
| `protocolVersion` | Exactly `1` — negotiation is exact, with no wildcard compatibility |
| `entryPoint` | A declared asset path ending `.html` |
| `capabilities` | Exactly `projection.read` and `record.select`, in either order. It is a fixed pair, not a permission list you extend |
| `license` | Non-empty text, at most 256 characters |
| `assets` | Every non-manifest file, each with its `path`, exact `bytes` and lowercase-hex `sha256`. The inventory must equal the archive contents exactly |

### Limits and path rules

At most 10 MiB of archive bytes, 30 MiB expanded, 200 entries including the manifest,
and a `manifest.json` of at most 64 KiB. Paths are relative, slash-separated, at most
240 characters, and may contain only letters, digits, `_`, `-`, `.` and `/`. Refused:
absolute paths, `.` and `..` segments, a segment ending in a dot, Windows reserved
names (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`), duplicate or
case-colliding paths, symlinks and reparse points, alternate data streams, and any
extension outside `.html`, `.css`, `.js`, `.txt`.

### Building reproducibly

The digest of the archive **is** the identity, so an unchanged source tree must
produce an unchanged digest. [`tools/Build-NendoViewPackage.ps1`](../tools/Build-NendoViewPackage.ps1)
packs any package: give it the source directory, the package ID, the version, the entry
point and the ordered asset list, as the two one-line wrappers beside it do. What makes
it reproducible:

- a fixed ZIP entry timestamp (`1980-01-01T00:00:00Z`) and `ExternalAttributes = 0`;
- a fixed entry order, `manifest.json` first;
- an ordered, compact manifest, so key order does not drift;
- the file hashes read from the same bytes that are written.

Build it, then read the pin:

```powershell
pwsh ./tools/Build-NendoViewPackage.ps1 -Source extensions/my-view `
  -PackageId org.example.my-view -PackageVersion 0.1.0 `
  -Assets index.html, view.css, view.js, LICENSE.txt      # prints Package: … and SHA-256: …
(Get-FileHash -LiteralPath <path>.nendoview -Algorithm SHA256).Hash.ToLowerInvariant()
```

Validation happens on the caller's exact archive bytes: the digest you pin, the byte
length and SHA-256 of every asset, and the bounds above, all read without extracting
or executing anything. Nendo's installer never silently installs a package.

## Part 3 — Pin it in a file

A view is authored with the ordinary canonical UI operations — `ui.addNode`,
`ui.setProperty`, `ui.removeNode` — through a change set the person accepts. There is
no second pipeline and no Studio builder for it; the published MCP example
`pin-an-offline-custom-graph` in `nendo://application/examples` is the copyable form.

```json
{
  "operationType": "ui.addNode",
  "payload": {
    "surfaceId": "dependencies",
    "nodeId": "dependencyGraph",
    "parentNodeId": null,
    "kind": "extensionGraphSurface",
    "position": 0,
    "properties": {
      "definitionVersion": 3,
      "entityId": "graphNode",
      "title": "Dependencies",
      "packageId": "org.example.my-view",
      "packageVersion": "0.1.0",
      "packageDigest": "<the archive SHA-256, 64 lowercase hex characters>",
      "protocolVersion": 1,
      "configurationVersion": 1,
      "configuration": "{}",
      "labelFieldId": "graphLabel",
      "edgeEntityId": "graphEdge",
      "sourceFieldId": "graphFrom",
      "targetFieldId": "graphTo"
    }
  }
}
```

| Property | Rule |
| --- | --- |
| `definitionVersion` | `3`; contract versions may not be mixed across roots |
| `entityId` | The **node** record type. The surface's own entity |
| `title` | Presentation only — it is not part of the consent digest |
| `packageId`, `packageVersion`, `packageDigest` | The exact pin. The digest is the archive's, never the manifest's |
| `protocolVersion`, `configurationVersion` | `1` and `1` for this host |
| `configuration` | JSON **text** holding an object, at most 8192 UTF-8 bytes, depth 8. Version 1 must be `"{}"` |
| `labelFieldId` | An active stored **Text** field of the node type |
| `statusFieldId` | Optional; an active stored non-reference scalar of the node type |
| `edgeEntityId` | The edge record type |
| `sourceFieldId`, `targetFieldId` | Two **distinct** active configured Reference fields of the edge type, both targeting the node type |

The root has no children. An invalid binding is refused as `NUI450`. A higher
`configurationVersion` is preserved verbatim and warns `NUI451`, and execution then
refuses with `extension-version-unsupported`. A file using this root requires host
**1.29.0**. Retiring a bound record type or field requires removing or replacing the
view in the same proposal. Removing the view never removes records; a single-operation
removal can be compensated while the definition revision is unchanged, and refuses
afterwards with `definition-revision-conflict`.

A definition is portable: it can be reviewed, accepted, copied and reopened on a
machine where the package does not exist. It carries no consent anywhere.

## Part 4 — Install, allow, open

On the person's device, in this order. The view's screen in Use shows exactly one next
step at a time, with a sentence saying where they are:

1. **Install package…** — a native file picker and package review. It validates the
   archive and caches it, content-addressed, outside the `.nendo` file. It grants no
   permission to run anything.
2. **Allow this view** — the native consent dialog, which names the exact package, its
   unsigned status, its digest and the human-readable field names it will read. This is
   the only thing that authorizes execution, and it is scoped to this physical file on
   this device.
3. **Open graph** — the view opens as a pane beside the records, with a host-owned
   toolbar (Open record, Focus graph, Refresh, Studio, Disable view, Close).

File → Custom views manages packages directly: install, export the exact original
bytes for offline transfer, remove, disable, or open a view after review.

While the view runs, Nendo re-reads the bounded typed view every 500 ms. Changed data
sends `replaceProjection` with a new generation; changed bindings stop execution;
withdrawn consent closes the session, checked every 100 ms even when the page is silent.

**Rebuilding the package changes its digest**, which is a different package. Any file
pinned to the old digest reports the package as changed and needs reinstalling and
allowing again. During development, expect to repeat all three steps on every build.

## When it refuses you

**The package will not install.** The message ends in a code:
`archive-size`, `archive-digest`, `file-count`, `manifest-missing`, `manifest-size`,
`manifest-version`, `manifest-object`, `manifest-properties`, `manifest-string`,
`duplicate-property`, `package-id`, `package-version`, `capabilities`, `entry-point`,
`asset-path`, `asset-link`, `asset-size`, `asset-type`, `asset-digest`,
`asset-inventory`, `expanded-size`, `malformed-content`. `asset-inventory` and
`asset-digest` almost always mean the manifest was written before the assets changed.

**The view opens and then closes.** The session refuses with one of `not-approved`,
`ready-timeout`, `message-rate-exceeded`, `message-too-large`, `invalid-message`,
`invalid-session`, `stale-generation`, `unknown-method`, `invalid-properties`,
`duplicate-property`, `already-ready`, `not-ready`, `record-outside-projection`,
`invalid-error`. The usual three: `ready` never sent (often because an inline script
was blocked and the page never ran), a message echoing an old `generation` after a
`replaceProjection`, and a `selectRecord` naming a node that is no longer in the
projection.

**The page is blank.** Check the fit-before-layout case above before anything else.

**The view's screen says the package is not available.** Its state is one of
`missing`, `corrupt` or `unavailable`; the next step becomes *Install package…* again.

## What is not solved

Honest limits, so a package does not advertise more than the host does:

- **No publisher signing, identity or key revocation.** Every package is unsigned and
  requires an explicit person-in-the-loop review.
- **No download, marketplace or update channel.** Packages move as files, offline.
- **One surface kind and one projection shape.** No second capability, no storage, no
  host navigation.
- **Release qualification is incomplete.** The installed-host and offline visible
  journeys and formal owner usability sign-off remain open for W-007, and the
  clean-user NSIS lane stays Not run under the owner-installation interlock.
