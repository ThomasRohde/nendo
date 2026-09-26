---
title: Custom views
description: What a custom view is, how its code travels in the file and runs inside Nendo, what it can reach, how to switch views off, and how to build your own.
group: Use
order: 60
---

A custom view is a small web page that draws your records in a way Nendo's own screens cannot: a graph of linked records, a Gantt chart, a map. Its code lives in the `.nendo` file as a **package**. A view that is shown runs, inside Nendo, in a frame of its own. There is nothing to install and nothing to allow.

## Where a view appears

- **As a screen.** A graph of linked records, or a view of one record type, is one of that record type's screens in Use, listed by its title. The view fills the screen.
- **On a record page.** A view can sit on a record page, about that page's one record: a Gantt bar for one task, say. It starts when you scroll it into sight. On a record that is not saved yet, it asks you to save first.

A redraw of the page around a view does not restart it. When you leave the screen, the view stops.

## How the code gets into the file

A package arrives the way every other change to the application does: as a proposal that you review and accept. The review has a **Code** section with every changed line of each file, and it says, once, that the code runs when a view that uses its package is shown. Nothing runs until you accept.

There are three ways to propose a package:

- **Studio › Surfaces › Custom views › Import package…** Pick a folder's `nendo-package.json`, a `.zip` of the folder, or an older `.nendoview` file. **File › Custom views…** opens the same panel.
- **An agent** writes the package over MCP with the operations `extension.setPackage` and `extension.putFile`, in a change set, and you accept it. See [Agents](/nendo/docs/agents).
- **A script.** From a clone of the repository, `node tools/Put-NendoPackage.mjs <folder>` proposes a package folder into the file that a running Nendo has open.

Each way proposes only what differs from the package the file already carries. When you accept a change to a package's code, its views start again on the new code. In the same panel, **Export…** writes a package to a folder, and **Remove…** takes it out of the file, again as a proposal.

A copy of the file carries its views' code. If a view names a package that the file does not carry, the view says so and offers **Add package to file…**, which is Import.

A view also needs a definition: a screen, a graph or a record-page panel that names its package, the record type it is about and the fields it shows. In **Studio → Surfaces → Custom views**, each package lists where it is already shown and has **Add view…**. The form offers only fields that work, and **Preview view** opens the ordinary review. After you accept a screen, Use opens on it. An agent can write the same definition through a change set, with extra fields and filters the form does not ask for. The [authoring guide](https://github.com/ThomasRohde/nendo/blob/main/docs/custom-view-authoring.md) shows each kind.

## What a view can and cannot do

| A view can | A view cannot |
| --- | --- |
| Read every record in the file, with calculated fields and exact numbers | Change a record, run a command or propose a change, in this version |
| Hear every change to the file, and draw again | Reach Nendo's own page or the bridge to the desktop app |
| Use the network, including programs on your own computer | Reach SQL, a file path, another file or a setting of this computer |
| Read and write the clipboard, and download files | Use Nendo's agent connection |
| Keep browser storage for itself, on this computer | Navigate Nendo away, or load Nendo inside itself |
| Ask Nendo to open a record, a screen or Studio, and show a sentence | Accept or reject a proposal |

Each package runs on a web address of its own, in a browser process of its own, apart from Nendo's own page. A view that hangs or crashes stays in its own place.

## Before you open someone else's file

A file that somebody else wrote brings its views' code with it, and that code runs when its view is shown. You have not read it: the review happened wherever the change was made. It can read every record in the file, reach the network, including programs on your own computer, use the clipboard and download files. It can also change your records and run their commands, the way you would. Each change is in **History** under the package's name, where you can undo it.

This is a deliberate trade for an exploratory project: no install step and no permission dialog, in exchange for switches. The switches below are the whole control. Turn views off before you open a file you do not trust.

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

The repository has four MIT-licensed example packages under [`extensions/`](https://github.com/ThomasRohde/nendo/tree/main/extensions). Three have no dependencies; `work-dependencies` carries elkjs, the Eclipse Layout Kernel, unchanged in its `vendor` folder under the Eclipse Public License 2.0. Each folder has a `nendo-package.json`, so you import it as it is.

| Package | Shows |
| --- | --- |
| [`dependency-graph`](https://github.com/ThomasRohde/nendo/tree/main/extensions/dependency-graph) | A general record graph with pan, zoom, keyboard selection and a text list of the relationships |
| [`work-dependencies`](https://github.com/ThomasRohde/nendo/tree/main/extensions/work-dependencies) | Work items and what blocks what, laid out by the Eclipse Layout Kernel in the order the work must happen, with links routed at right angles. It groups items by any field, filters by status, finds by title, marks cycles and the longest chain, and dims everything not connected to the selection |
| [`systems-lens`](https://github.com/ThomasRohde/nendo/tree/main/extensions/systems-lens) | Components and the feeds between them, for the Nendo Station demo file. It marks loops, and **Take out** shows which components lose every declared supply path when one is removed. It writes nothing |
| [`gantt`](https://github.com/ThomasRohde/nendo/tree/main/extensions/gantt) | One record type on a time line, from a start date to an end date; a record with only a start is a diamond. It also works on a record page, for one record |

The demo files in the repository were made before views ran from the file. Their views name a package that the file does not carry yet, and offer **Add package to file…**.

## Build your own

The full guide is [Authoring a custom view](https://github.com/ThomasRohde/nendo/blob/main/docs/custom-view-authoring.md). In outline:

1. **Write the page.** Plain HTML, CSS and JavaScript files, or a bundler's output folder. Any file type is allowed. Before your own script, load the view API with a script tag whose source is `/_nendo/api.js`: every view's web address serves it.
2. **Read the file.** `await nendo.ready` gives the view's context. `nendo.view.loadRecords()` and `nendo.view.loadGraph()` read what the view is about, and `nendo.records.query(...)` reads any record type. Follow `nendo.on('changes', ...)` to draw again when the file changes.
3. **Look like Nendo.** Draw with the `--nendo-*` colour variables that the API sets, and the view follows Light and Dark. Set labels as text, never as markup.
4. **Act for the person.** `nendo.ui.openRecord(entityId, recordId)` opens a record beside the view. `nendo.records.update(...)` and `nendo.commands.run(...)` change records the way you would, `nendo.proposals.prepare(...)` asks for a change to the app that you review, and `nendo.state.set(...)` keeps a small value with the file. Each change is in **History** under the package's name.
5. **Name the package.** A `nendo-package.json` with a `packageId` such as `org.example.map`, and a title.
6. **Put it in the file, and define a view that names it.** Accept both proposals, and the view runs.

To debug, right-click inside the running view and choose **Inspect**. To run code inside the view, choose its frame as the Console's context, in the drop-down that starts at `top`.

## Limits

| Limit | Value |
| --- | ---: |
| One file in a package | 4 MiB |
| One package | 512 files and 16 MiB |
| Packages in one `.nendo` file | 64, and 64 MiB of code in all |
| New code in one proposal | 4 MiB |
| A view's configuration | 16 KiB of JSON |

A file that carries a package needs file capability 1.33.0 or later, and a view defined with the newer, open rules needs 1.34.0. See [Files and data](/nendo/docs/files-and-data).

## Not yet

- A view as a screen of its own, and a view as a tile on the front page, are not built.
- Packages are not signed. There is no marketplace, download or update channel: packages move inside files and as folders.
