---
title: Custom views
description: What a custom view is, how its code travels in the file and runs inside Nendo, what it can reach, how to switch views off, and how to build your own.
group: Use
order: 60
---

A custom view is a small web page that draws your records in a way Nendo's own screens cannot: a graph of linked records, a Gantt chart, a map. Its code lives in the `.nendo` file as a **package**. A view that is shown runs, inside Nendo, in a frame of its own. There is nothing to install and nothing to allow.

## Where a view appears

- **As a screen of a record type.** A graph of linked records, or a view of one record type, is one of that record type's screens in Use, listed by its title. The view fills the screen.
- **As a screen of the file.** A view about the whole file is listed in Use before the record types, and a file can open on it. `workspace/Archi.nendo` opens on its modeller this way.
- **On a record page.** A view can sit on a record page, about that page's one record: a Gantt bar for one task, say. It starts when you scroll it into sight. On a record that is not saved yet, it asks you to save first.

A redraw of the page around a view does not restart it. When you leave the screen, the view stops.

## A view's controls are Nendo's

A view can hand its controls to Nendo. The view says what it offers: buttons, switches, choices, a search box and menus. Nendo draws them in the screen's one row under the address bar, next to **Add**, or in the panel's heading on a record page. The row stays one line: in a narrow window, what does not fit moves into a **More** menu at its end. The breadcrumb at the top picks the record type and the view, so nothing else stands between the top bar and the view. The example views also put their summary in that row, and keep their explanation behind an **About** button. Then:

- **Ctrl K** lists the view's commands under its title, with their keys.
- **Keys** that a view declares work anywhere in the window, except while you type in a field. Nendo's own keys, such as Ctrl K, Ctrl 1 to 7 and Alt F, keep working while the view has focus.
- **Add** on the view's screen can be the view's own. In the Capability map it adds a capability under the one you selected.
- **Right-click** inside a view can open Nendo's menu. In the Capability map it offers Open record, Rename and the moves.

A view never puts its own markup into Nendo's toolbar or menus: Nendo draws the words it is given, as words.

## How the code gets into the file

A package arrives the way every other change to the application does: as a proposal that you review and accept. The review has a **Code** section with every changed line of each file, and it says, once, that the code runs when a view that uses its package is shown. Each file starts folded, showing its name, sizes and how many lines it adds and removes; open one to read its lines. Nothing runs until you accept.

There are three ways to propose a package:

- **Studio › Surfaces › Custom views › Import package…** Pick a folder's `nendo-package.json`, a `.zip` of the folder, or an older `.nendoview` file. **File › Custom views…** opens the same panel.
- **An agent** writes the package over MCP with the operations `extension.setPackage` and `extension.putFile`, in a change set, and you accept it. See [Agents](/nendo/docs/agents).
- **A script.** From a clone of the repository, `node tools/Put-NendoPackage.mjs <folder>` proposes a package folder into the file that a running Nendo has open.

The script leaves the proposal for you to accept. With `--accept`, only
Unattended access permits it to accept its own proposal. If acceptance loses its
response, the script reports the uncertainty and exits unsuccessfully: inspect
Pending changes and History before trying again.

Each way proposes only what differs from the package the file already carries. When you accept a change to a package's code, its views start again on the new code. In the same panel, **Export…** writes a package to a folder, and **Remove…** takes it out of the file, again as a proposal.

A copy of the file carries its views' code. If a view names a package that the file does not carry, the view says so and offers **Add package to file…**, which is Import.

A view also needs a definition: a screen, a graph or a record-page panel that names its package, the record type it is about and the fields it shows. In **Studio › Surfaces › Custom views**, each package lists where it is already shown and has **Add view…**. The form offers only fields that work, and **Preview view** opens the ordinary review. After you accept a screen, Use opens on it. An agent can write the same definition through a change set, with extra fields and filters the form does not ask for. An agent can also make a view a screen of the file itself, listed before the record types and, if the definition says so, the screen the file opens on. With custom views off, such a file opens on its front page or its first record type instead. The [authoring guide](https://github.com/ThomasRohde/nendo/blob/main/docs/custom-view-authoring.md) shows each kind.

## What a view can and cannot do

| A view can | A view cannot |
| --- | --- |
| Read every record in the file, with calculated fields and exact numbers | Reach Nendo's own page or the bridge to the desktop app |
| Change records, run commands and propose changes, each in **History** under its package's name | Reach SQL, a file path, another file or a setting of this computer |
| Hear every change to the file, and draw again | Use Nendo's agent connection |
| Use the network, including programs on your own computer | Navigate Nendo away, or load Nendo inside itself |
| Read and write the clipboard, read a file you choose or drop on it, and download files | Accept or reject a proposal |
| Keep browser storage for itself, and small values in the file | Put markup of its own in Nendo's toolbar or menus |
| Ask Nendo to open a record, a screen or Studio, show a sentence, and draw its controls and menus | |

Each package runs on a web address of its own, in a browser process of its own, apart from Nendo's own page. A view that hangs or crashes stays in its own place.

## Before you open someone else's file

A file that somebody else wrote brings its views' code with it, and that code runs when its view is shown. You have not read it: the review happened wherever the change was made. It can read every record in the file, reach the network, including programs on your own computer, use the clipboard, read a file you choose or drop on it, and download files. It never gets a file you did not choose. It can also change your records and run their commands, the way you would. Each change is in **History** under the package's name.

History offers **Compensate** where it can reverse a change, a view's batch included: a record the batch created is deleted, and a record it deleted comes back. A view can do the same itself for what it wrote since it opened: `nendo.records.undo(revision)` takes a batch back and `nendo.records.redo(...)` makes it again, each as a new entry in History, and refused if somebody else changed those records since. See [History and undo](/nendo/docs/files-and-data#history-and-undo) for the reversibility classes and other limits.

This is a deliberate trade: no install step and no permission dialog, in exchange for switches. The switches below are the whole control. Turn views off before you open a file you do not trust.

## Switching views off

| Switch | Where | What it covers |
| --- | --- | --- |
| **Run custom views** | Studio › Surfaces › Custom views | Every file, on this computer |
| **Run this file's views** | Studio › Surfaces › Custom views | This file, on this computer |
| **Restart without custom views** | The recovery panel, when the app view has stopped | Views stay off until you turn **Run custom views** on again or start Nendo again |

Both switches are settings of this computer. They never change the file, and a file cannot turn its own views back on. Views never run in safe mode, during recovery, or while a file needs attention, for example when it opened read-only. A view that cannot run says why where it would be, with the step that changes it. **Health** shows whether views run.

## When a view misbehaves

- A view that stops responding for ten seconds is marked **This view is not responding**, with **Stop** and **Reload**. Stop ends every view of the same package, because they share one browser process. The rest of Nendo keeps working.
- A view whose page crashes says **This view stopped**, with **Reload**.
- If a view takes the whole window down, the recovery panel offers **Restart without custom views**.

Studio is there in every case, and your records stay editable.

## The examples

The repository has eight example packages under [`extensions/`](https://github.com/ThomasRohde/nendo/tree/main/extensions). Each folder has a `nendo-package.json`, so you import it as it is. Four have no dependencies. The others keep third-party code unchanged in a `vendor` folder, with its licence: `work-dependencies` and `archi` carry elkjs, the Eclipse Layout Kernel (Eclipse Public License 2.0), `garden` carries d3 (ISC) and Mermaid (MIT), and `swarm` carries bpmn-js under the bpmn.io licence. Every package except `swarm` is MIT-licensed; `archi` lists the further libraries it builds in under `THIRD-PARTY.txt`.

| Package | Shows |
| --- | --- |
| [`dependency-graph`](https://github.com/ThomasRohde/nendo/tree/main/extensions/dependency-graph) | A general record graph with pan, zoom, keyboard selection and a text list of the relationships |
| [`work-dependencies`](https://github.com/ThomasRohde/nendo/tree/main/extensions/work-dependencies) | Work items and what blocks what, laid out by the Eclipse Layout Kernel in the order the work must happen, with links routed at right angles. It groups items by any field, filters by status, finds by title, marks cycles and the longest chain, and dims everything not connected to the selection |
| [`systems-lens`](https://github.com/ThomasRohde/nendo/tree/main/extensions/systems-lens) | Components and the feeds between them, for the Nendo Station demo file. It marks loops, and **Take out** shows which components lose every declared supply path when one is removed. It writes nothing |
| [`gantt`](https://github.com/ThomasRohde/nendo/tree/main/extensions/gantt) | One record type on a time line, from a start date to an end date; a record with only a start is a diamond. **Find** (Ctrl F) picks out rows by name. It also works on a record page, for one record |
| [`bcm-atlas`](https://github.com/ThomasRohde/nendo/tree/main/extensions/bcm-atlas) | A business capability map over a five-level hierarchy of 635 fictional capabilities: nested packing with fixed-size cards, levels, focus, search, heatmaps, and editing with version checks. It reads the capabilities as the tree the file keeps, so it needs the record type kept as a tree. It works over any such record type: the view's configuration says which of its fields is the maturity, the importance and so on, and what it is not told is left out. Capabilities move by dragging or with Alt+Shift+arrows, and F2 renames one. It exports the map as an SVG to edit or a PNG for a slide. Where the file keeps dated assessments, a capability shows its latest score on each dimension, the map can colour by the change since a chosen date, and **Importance × health** places every capability by its importance against its IT health. **Application coverage** colours a capability by how many applications support it or anything below it, **Capability × application** lays capabilities against the applications that support them with each link's role and fit, and an initiative can cover several capabilities. `workspace/BCM.nendo` carries it |
| [`garden`](https://github.com/ThomasRohde/nendo/tree/main/extensions/garden) | A garden of Markdown notes: a tree of notes, each opening for reading with Edit a key away, a hover preview of a linked note, and a save that turns `[[wikilinks]]`, `#tags` and `- [ ]` lines into Link, Tag and Task records in one undoable batch, planting a Seed note for a link to nothing. A fence marked `mermaid` is drawn as a diagram in the garden's colours. **Find** searches what every note says, through the file's search index. Its graph screen is a living d3 force layout you drag, zoom and hover, and a note's own neighbourhood is drawn under it. Its **Agenda** lists the open tasks by when they are due and ticks them in their notes, and **Tend** asks for the notes left alone a while. The same package is the Backlinks panel on a note's page, and the **Overview** that `workspace/Garden.nendo` opens on: the whole garden as a graph, with a box that finds a note or names a new one, and the pinned notes as cards |
| [`archi`](https://github.com/ThomasRohde/nendo/tree/main/extensions/archi) | An ArchiMate 3.2 modeller in the manner of Archi: the model tree, views drawn with Archi's figures, properties, analysis and the Visualiser, as a screen of the file. `workspace/Archi.nendo` opens on it |
| [`swarm`](https://github.com/ThomasRohde/nendo/tree/main/extensions/swarm) | A behaviour playground: creature behaviours edited as bpmn-js diagrams, a habitat that runs them, and experiments that replay. `workspace/Swarm.nendo` carries it |

Each demo file under [`workspace/`](https://github.com/ThomasRohde/nendo/tree/main/workspace) carries its package. When the repository has a newer version of a package than the file, import it as above.

## Build your own

The full guide is [Authoring a custom view](https://github.com/ThomasRohde/nendo/blob/main/docs/custom-view-authoring.md). In outline:

1. **Write the page.** Plain HTML, CSS and JavaScript files, or a bundler's output folder. Any file type is allowed. Before your own script, load the view API with a script tag whose source is `/_nendo/api.js`: every view's web address serves it.
2. **Read the file.** `await nendo.ready` gives the view's context. `nendo.view.loadRecords()` and `nendo.view.loadGraph()` read what the view is about, and `nendo.records.query(...)` reads any record type. Follow `nendo.on('changes', ...)` to draw again when the file changes.
3. **Look like Nendo.** Draw with the `--nendo-*` colour variables that the API sets, and the view follows Light and Dark. Set labels as text, never as markup. For keyboard and screen-reader support, copy the view kit (`tools/view-kit/nendo-view-kit.js`) into the package: it gives a list or a graph one tab stop with arrow keys, a focus ring in the theme's colour, and a text alternative for a drawing.
4. **Act for the person.** `nendo.ui.openRecord(entityId, recordId)` opens a record beside the view. `nendo.records.update(...)` and `nendo.commands.run(...)` change records the way you would, `nendo.records.batch(...)` makes several changes that land together or not at all, `nendo.proposals.prepare(...)` asks for a change to the app that you review, and `nendo.state.set(...)` keeps a small value with the file. Each change is in **History** under the package's name.
5. **Name the package.** A `nendo-package.json` with a `packageId` such as `org.example.map`, and a title.
6. **Put it in the file, and define a view that names it.** Accept both proposals, and the view runs.

An agent that writes a view over MCP reads `nendo://application/view-api` first: every `window.nendo` call with its parameters and answer, the toolbar's controls and icons, the theme's colours and a whole view to start from.

To debug, right-click inside the running view and choose **Inspect**. To run code inside the view, choose its frame as the Console's context, in the drop-down that starts at `top`.

## Limits

| Limit | Value |
| --- | ---: |
| One file in a package | 4 MiB |
| One package | 512 files and 16 MiB |
| Packages in one `.nendo` file | 64, and 64 MiB of code in all |
| New code in one proposal | 4 MiB |
| A view's configuration | 16 KiB of JSON |

A file that carries a package or defines a view records that it needs a Nendo that can run them. See [Minimum host version](/nendo/docs/files-and-data#minimum-host-version).

## Not yet

- A view as a tile on the front page is not built.
- Packages are not signed. There is no marketplace, download or update channel: packages move inside files and as folders.
