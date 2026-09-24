---
title: Custom views
description: What a custom view is, how to install, pin and allow one, how Nendo contains it, and how to build your own.
group: Use
order: 60
---

A custom view is a small web page that draws records in a way Nendo's own screens cannot. It renders a **bounded, read-only graph of records**, or **one record type as typed columns** (a Gantt chart, a map, a heat map), and it opens in a pane of the main window beside your records.

A custom view is not a plugin system. It cannot add storage, run queries, write records, reach the network or ask for more permissions. The only thing it can send back to Nendo is "this record is selected".

## What a custom view shows

A graph view uses two record types from your file:

- a **node** type, for example Component or Work item, with a Text field for the label and, optionally, one field for a status;
- an **edge** type, for example Feed or Dependency, with two Reference fields that point from one node to another.

Nendo reads these fields and nothing else, and sends them to the view as a list of nodes and a list of edges. This list is the **projection**. Nendo sends a new projection when the data changes.

| Limit | Value |
| --- | ---: |
| Nodes | 500 |
| Edges | 1,000 |
| Projection size | 1 MiB |
| Label or status text | 4,096 characters |

A graph over a limit is refused whole. There is no paging and no partial graph. Cycles, self-links, parallel edges and records with no links are all valid.

A **record view** uses one record type and no links. Nendo sends the named fields of up to 1,000 records, each value typed (text, number, date and so on), and refuses a larger set whole in the same way. A record view needs Nendo 1.31.0 or later.

## Three separate steps

A view needs three things. Each is a separate act, and none of them implies the next.

| Step | What it is | Where it lives |
| --- | --- | --- |
| 1. Install the package | A `.nendoview` archive. Its SHA-256 digest is its identity. Nothing signs it. | This computer, outside the `.nendo` file |
| 2. The view definition | A screen in the file that pins the package by ID, version and digest, and names the fields the view may read | The `.nendo` file |
| 3. Allow on this computer | A native review of the exact package, its digest, that it is unsigned, and the names of the fields it reads | This computer, for this physical file |

Installing a package grants no permission to run. Accepting a view definition installs nothing and allows nothing. Only step 3 lets the view run.

In Use, the view's screen shows one next step at a time, with a sentence that says where you are:

1. **Install package…** opens a file picker and a package review.
2. **Allow this view** opens the native consent dialog.
3. **Open graph**, or **Open view** for a record view, opens the pane.

**Open Studio** and **Manage packages…** are always there. File → **Custom views…** installs, exports and removes packages, and reviews, opens or disables the views in the file.

Allowing a view is tied to this physical file on this computer. A copy of the file, even one with the same IDs, asks again. So does another computer. A new package build has a new digest, so it is a different package: install and allow it again. A change to the fields that the view reads also asks again.

A view definition is portable. You can review, accept, copy and reopen a file that pins a package you do not have. Opening a file never starts a view.

## The pane

The view opens in a pane on the right of the main window, at half its width and never narrower than 480 DIPs. Drag the boundary, or focus it and press Left or Right, to change the split. Double-click the boundary to go back to half.

The toolbar belongs to Nendo, not to the view:

| Button | Does |
| --- | --- |
| Open record | Opens the selected record next to the graph, where you can edit it |
| Focus graph | Moves keyboard focus into the view |
| Refresh | Reads the graph again |
| Studio | Opens Studio |
| Disable view | Withdraws permission on this computer; records and the definition stay in the file |
| Close | Closes the pane and stops the view |

F6 moves focus between the view and Nendo's controls. A selection in the view does nothing until you press **Open record**, and Nendo checks again that the record exists and that the view is still allowed.

## How Nendo contains a view

Nendo runs every view in a separate helper process with the following restrictions:

- **No network.** The helper runs in a Windows AppContainer with no capabilities, so it cannot open network connections, local or remote. The page also has a strict Content Security Policy.
- **No files and no host objects.** The page cannot read files, reach Nendo's database, call into Nendo or see the MCP server. The helper has no reference to Nendo's engine. It talks to Nendo over two private pipes.
- **No clipboard, downloads, pop-ups, frames, workers or developer tools.** The page cannot navigate away from its entry page.
- **Resource limits.** The helper and its browser processes share one Windows Job: 512 MiB of memory, 32 processes and 20% CPU. At 480 MiB Nendo stops the view and says why.
- **Message limits.** At most 60 messages a second and 64 KiB a message, with a fixed set of message types. The view must say it is ready within five seconds.
- **Consent is checked continuously**, every 100 ms while the view runs. Withdrawing permission closes it.

If a view stops, crashes or runs out of memory, the pane says so. Studio and your records stay available, and you can keep editing.

These limits measure what the helper can reach on this machine. Nendo does not sign packages or check who wrote them. You are the review.

## What a view can and cannot do

| A view can | A view cannot |
| --- | --- |
| Draw the nodes and edges it is given | Read a field that the definition does not name |
| Show one status value per node, and more fields the view names (protocol 2) | Read a calculated field, or any field the view does not name |
| Lay out, pan, zoom and filter in its own page | Write, create or delete a record |
| Suggest one selected record | Open a record, navigate Nendo or start a command |
| Follow Nendo's Light or Dark theme | Reach the network, files, clipboard or other programs |
| Keep state in memory while it is open | Keep state after it closes |

## The examples

The repository has four MIT-licensed example packages under [`extensions/`](https://github.com/ThomasRohde/nendo/tree/main/extensions). None has dependencies. The installer does not install them. Build each one with its script under `tools/`, then install the `.nendoview` file with **Install package…**.

| Package | Shows |
| --- | --- |
| [`dependency-graph`](https://github.com/ThomasRohde/nendo/tree/main/extensions/dependency-graph) | A general record graph with pan, zoom, keyboard selection and a text list of the relationships |
| [`work-dependencies`](https://github.com/ThomasRohde/nendo/tree/main/extensions/work-dependencies) | Work items and what blocks what, laid out left to right in the order the work must happen. It marks cycles, counts items that nothing blocks, and dims everything not connected to the selection. |
| [`systems-lens`](https://github.com/ThomasRohde/nendo/tree/main/extensions/systems-lens) | Components and the feeds between them, for the Nendo Station demo file. It marks loops, and a **Take out** mode shows which components lose every declared supply path when one is removed. It writes nothing. |
| [`gantt`](https://github.com/ThomasRohde/nendo/tree/main/extensions/gantt) | One record type on a time line, from a start date to an end date, as bars; a record with only a start is a diamond. It is a record view rather than a graph, so it needs no links. |

## Build your own

The full guide is [Authoring a custom view](https://github.com/ThomasRohde/nendo/blob/main/docs/custom-view-authoring.md). In outline:

1. **Write the page.** Plain HTML, CSS and JavaScript files, with no build step. Only `.html`, `.css`, `.js` and `.txt` files are allowed. Put all script in `.js` files: inline scripts and inline event handlers are blocked. Bundle any library as a local file.
2. **Handle the messages.** Nendo sends `initialize`, `replaceProjection` and `setTheme` through `window.chrome.webview`. The page sends `ready` within five seconds, then `selectRecord` or `reportError`. Every message carries exact keys.
3. **Render with care.** Set labels with `textContent`. Support the keyboard and both themes, and give a text alternative. Fit the graph after the pane has its size.
4. **Package it.** Write a `manifest.json` that lists every asset with its size and SHA-256, and zip it as a `.nendoview`. [`tools/Build-NendoViewPackage.ps1`](https://github.com/ThomasRohde/nendo/blob/main/tools/Build-NendoViewPackage.ps1) builds a reproducible archive and prints its digest.
5. **Pin it in a file.** Add an `extensionGraphSurface` screen, or an `extensionRecordsSurface` screen for a record view, with the package ID, version and digest and the fields to read, through a change set that a person accepts. The MCP example `pin-an-offline-custom-graph` shows the shape. See [Agents](/nendo/docs/agents).
6. **Install, allow, open.** Each rebuild changes the digest, so repeat all three steps after every build.

A package is at most 10 MiB, 30 MiB expanded and 200 files. A file that uses a custom view needs Nendo 1.29.0 or later.

## Limits of the design

- Packages are not signed. There is no publisher identity and no revocation.
- There is no marketplace, download or update channel. Packages move as files.
- There are two kinds of view, a graph and a record view, and each opens only in the pane. A view cannot yet sit inside a record page.
- A view cannot be given a new capability. Any wider access would need a new design, not a setting.
