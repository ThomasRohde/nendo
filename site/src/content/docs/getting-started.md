---
title: Getting started
description: Build Nendo from source, install it, open or create a .nendo file, find your way around Studio and make your first record type by hand.
group: Start
order: 10
---

This guide takes you from a clone of the repository to a file with your own records in it. The [Use page](/nendo/use) gives the short version. Nendo is a research prototype. Read [Status](/nendo/status) before you rely on it.

## Requirements

| You need | Detail |
| --- | --- |
| Windows x64 | Nendo runs on Windows only. There is no ARM64 build. |
| WebView2 Evergreen runtime | The app draws its interface in WebView2. Most Windows 11 computers already have it. |
| .NET SDK | The version pinned in [`global.json`](https://github.com/ThomasRohde/nendo/blob/main/global.json) (10.0.204, later feature bands are accepted). |
| Node.js 22.12 or later | Declared under `engines` in `src/Nendo.Workbench/package.json`. The build uses `npm`. |
| PowerShell 7 | The build and test scripts are `.ps1` files run with `pwsh`. |
| NSIS | Only to package the installer (`makensis` on your `PATH`). |

There is no download, no signed installer and no automatic update. You build the installer yourself.

## Build from source

1. Clone the repository and run the full test gate:

   ```powershell
   git clone https://github.com/ThomasRohde/nendo
   cd nendo
   pwsh ./tools/Test-Production.ps1
   ```

   The gate restores the Workbench packages with `npm ci`, builds the Workbench, builds the .NET solution and runs the tests. It takes about a minute after the first restore. The Workbench is the web interface that the desktop app bundles, so it is built first.

2. Publish the app and package the installer:

   ```powershell
   pwsh ./tools/Publish-NendoPayload.ps1
   pwsh ./tools/Build-NendoInstaller.ps1
   ```

   The result is `artifacts/installer/Nendo-Setup.exe`, an unsigned per-user installer.

## Install

Run `artifacts/installer/Nendo-Setup.exe`. The installer is unsigned, so Windows can warn before it runs. The installer writes to your user profile under `Programs\Nendo` and needs no administrator rights. Running a newer installer upgrades that installation in place.

The installer also:

- registers the `.nendo` file type with its own document icon, so a double-click opens a file in Nendo;
- adds **New › Nendo application** to the Explorer context menu;
- adds Nendo to the Start menu and to Windows' installed apps, where you uninstall it.

Uninstall removes the files the installer put there. It keeps your `.nendo` files and the settings stored on this computer.

## Open or create a file

A `.nendo` file is one application: its record types, records, screens and history. See [Files and data](/nendo/docs/files-and-data) for what it holds.

| To | Do this |
| --- | --- |
| Create a file from Explorer | Right-click in a folder and choose **New › Nendo application**. Explorer names the file; Nendo creates a real empty file and opens it. |
| Create a file in the app | On the start screen, choose **Create Nendo file**. With a file already open, choose **Close file** from the file menu first; **New file** is available only when no file is open. |
| Open a file you have | Double-click it in Explorer, choose **Open Nendo file** on the start screen, or choose **Open file…** from the file menu. |
| Open a recent file | The start screen lists up to four recent files. Right-click Nendo's taskbar button for the same list. |
| Drag a file in | Drop one `.nendo` file on the window. Nendo opens one file at a time and refuses a drop of several. |

Keep the file in a local folder. Nendo warns when a file is in a folder that OneDrive, Dropbox or Google Drive syncs, and does not support writable use there.

There is no **Save** command. Nendo saves each successful edit as you make it.

Closing the window does not close the file. Nendo stays in the notification area with the file open. Use **Close file** in the file menu, or choose **Exit Nendo** from the notification area icon's menu.

## An empty file is a working application

A new file has no record types, no records and no screens, and it is valid. Nendo never adds sample data or screens on its own. The Data area says **This file is ready** and offers **Create record type**.

## Studio

Studio is the part of Nendo that the host provides for every file. No file content can remove it or hide it. It has five areas, listed under **Studio** in the navigation.

| Area | What it shows | What you can do there |
| --- | --- | --- |
| **Data** | Each record type as a table, with a record editor. | Add, edit and delete records; sort, filter and search; open **Show retired data**. |
| **Structure** | Record types and their fields. | **Add field**, **Rename**, **Rename record type**, **Edit choices**, make a field required or optional, retire and reactivate. Each change opens a proposal for you to review. |
| **Surfaces** | The screens the file defines and what each one is bound to. | Read screen definitions and their diagnostics. |
| **History** | Every saved change, in order, with its lane and its reversibility. | **View changes** on an entry, and **Compensate** where Nendo can reverse it. |
| **Health** | Whether the file is ready for editing, read-only or in recovery, and the last integrity check. | Create and restore backups, export readable data, re-inspect the file, and approve automatic actions on this computer. |

Three more items sit beside Studio in the navigation. **Use** opens the screens the file defines (lists, boards, calendars, record pages); it has nothing to show until the file has screens. **Agent** controls agent access. **Help** is built in and works with no file open.

## Your first record type and records, by hand

You do not need an agent for this.

1. In **Data**, choose **Create record type**.
2. Enter a name for the record type, for example `Book`. **First field** starts as `Name`; keep it or change it. This first field is required short text.
3. Choose **Preview record type**. Nendo builds a proposal and shows the review: **What changes** lists each operation, **What this builds** describes the file as it will be.
4. Choose **Accept changes**. The record type now exists. **Reject** leaves the file unchanged.
5. Choose **Add Book**, enter a name and choose **Add**. The record is saved.
6. To change a value, double-click a cell in the table, edit it and press Enter.

To add more fields, open **Structure**, select the record type and choose **Add field**. The field types are Short text, Long text, Choice, Whole number, Rating on a scale, Decimal, Yes / No, Date, Date and time with timezone, UUID and Reference to another record. A new field is optional, so existing records stay valid. It goes through the same review as the record type.

This split is the rule for the whole product. A change to records (the data lane) saves at once and adds one entry to History. A change to the shape of the application (record types, fields, screens) is a proposal: a set of typed operations that Nendo validates on a private copy of the file and shows you before anything changes. The [concepts guide](/nendo/docs/concepts) explains both lanes.

Every record type gets its table and record editor in Studio. Other screens, such as a board or a calendar, come from a proposal. In practice an agent writes most of them.

## Connect an agent

Nendo has no built-in agent. A coding agent such as Claude Code or Codex connects to the open file over MCP at `http://127.0.0.1:41763/mcp`, after you turn agent access on in the **Agent** area and choose a level: Off, Inspect, Edit data, Shape app or Unattended. There is no key or password, so any program on this computer can connect at the level you chose; set access to Off when no agent is working. A clone of this repository already registers the server for both clients. The agent writes proposals, and you accept them in Nendo. The [agents guide](/nendo/docs/agents) covers the access levels, the connection commands and what an agent can and cannot do.

## Try Nendo Station

Nendo Station is a demonstration file: a fictional orbital habitat with nine record types (Modules, Systems, Components, Feeds, Readings, Incidents, Maintenance, Experiments, Crew), about 500 records and every kind of screen Nendo draws. It is in the repository at [`workspace/Nendo Station.nendo`](https://github.com/ThomasRohde/nendo/blob/main/workspace/Nendo%20Station.nendo).

To look around, open the file. It starts on the **Station status** front page. Two things ask for your consent on this computer before they work:

- The file has automatic actions. Editing stays off until you choose **Approve automatic actions** under **Health**. Reading works without it.
- The **Systems Lens** schematic is a custom view. It needs its package, built with `pwsh ./tools/Build-NendoSystemsLensPackage.ps1` and installed through **File › Custom views…**, and your permission for this file. See [Custom views](/nendo/docs/custom-views).

To keep the tracked file unchanged, open it and use **Duplicate…** from the file menu, then work in the copy. A copy asks for both consents again.

The file is an output. [`tools/Build-NendoStation.mjs`](https://github.com/ThomasRohde/nendo/blob/main/tools/Build-NendoStation.mjs) authors it from an empty file over MCP, one stage at a time:

```powershell
node tools/Build-NendoStation.mjs --list    # the stages, in order
node tools/Build-NendoStation.mjs           # the first stage not yet applied
```

To rebuild it, create an empty file in Nendo, turn agent access on at a level that lets an agent shape the app, and run the script once for each stage. Each schema, behaviour and screen stage becomes a proposal that you accept in Nendo; the script never accepts one. The data stages write records directly. The `readings-csv` stage writes `artifacts/station/readings.csv`, which you import into Readings with **Import CSV…** and the Nendo CSV profile. Build and allow the Systems Lens package before the `pin` stage. The script dates the data relative to the day you build it.

## Next

- [Concepts](/nendo/docs/concepts) for the terms this guide uses.
- [Screens](/nendo/docs/screens) for what a file can show in Use.
- [Files and data](/nendo/docs/files-and-data) for CSV, history, copies and recovery.
