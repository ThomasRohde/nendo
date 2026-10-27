# Web page export contract

This contract covers an application exported as one web page: what Export writes, what the page
carries and keeps, and how Apply changes brings the page's edits back.

- **Decision:** [ADR-0035](../decisions/0035-an-app-exported-as-one-web-page.md), on the browser
  host of [ADR-0036](../decisions/0036-nendo-runs-in-a-browser.md)
- **Code:** `src/Nendo.Session/NendoWebPageExport.cs`; `src/Nendo.Engine/NendoWriteCoordinator.WebPage.cs`;
  in the Desktop host, `MainPage.FileActions.cs`; in the Workbench, `host-browser.ts` and
  `scripts/pack-browser-host.mjs`

## The command

**File → Web page…** (`file.webPage`, in the Copies section) opens a Nendo dialog with two
buttons: **Export…** and **Apply changes…**. Apply changes is enabled while the file can be
written. The entry is not offered by the browser host itself.

## Export

1. The person picks where the page goes; the name offered is the file's name with `.html`.
2. Nendo says what the page is before it writes anything: "The page holds a copy of every record
   in this file. Anyone who opens it can read them, and can change their own copy. Their changes
   reach this file only when you apply them with Apply changes from a web page."
3. `NendoWebPageExport.ExportAsync` makes a **Duplicate** of the open file
   ([ADR-0010](../decisions/0010-file-identity-duplicate-fork-backup-and-restore.md)) in a folder of
   its own under the temporary folder, carries it into a copy of the page runtime, writes the page
   beside the destination as a `.partial` file and moves it into place. It never replaces an
   existing file; the temporary folder is removed afterwards.

The open file does not change. The Duplicate's `identity.transition` records the source's
instance ID and change sequence: the **export point** that Apply changes reads.

| Refusal | When |
| --- | --- |
| `file-too-large` | The file, or its Duplicate, is over 256 MiB (`NendoWebPageExport.MaximumFileBytes`, the browser host's own limit). The message names the size: "Station.nendo is 300.2 MiB; a web page opens files of up to 256 MiB." The open file's size is checked before the copy is made. |
| `web-page-runtime-missing` | The page runtime is not installed, or has no module script to carry a file beside. |
| `unsupported-sync-location` | The destination is in a cloud-sync folder and the person has not accepted unsupported use, as for every copy. |

## The page

The page runtime is the browser host page, `tools/Build-BrowserHost.ps1`'s
`artifacts/browser-host/Nendo.html`. The Desktop payload ships it as `WebPage/Nendo.html`, so an
installed Nendo exports with no network. It holds, in this order before its module script:

| Element | Holds |
| --- | --- |
| `<template id="nendo-notices">` | The licences of everything the page carries: Nendo, the Workbench's packages and Lucide's icons, the .NET runtime and its third-party notices, and every NuGet package the runtime publishes, with SQLite's public-domain dedication. Inert: nothing reads it. |
| `<script type="application/json" id="nendo-runtime">` | The .NET runtime's files, gzipped and base64, and its boot config. |
| `<script type="application/json" id="nendo-view-api">` | The view API, `/_nendo/api.js`. |
| `<script type="application/octet-stream" id="nendo-file" data-name="…">` | The exported file, gzipped and base64. Only an exported page has it. |

The page's own code makes no network request, from disk or from a web server. Linked pictures
load from their addresses, and a view keeps the network rule it has in Nendo. Agent access does
not exist in the page.

### Opening and keeping

- The page opens the file it carries as it starts.
- The **working copy** is kept in the IndexedDB database `nendo-browser-host` (version 2, store
  `files`) under `page-file:` and the SHA-256 of the carried text. Each exported page has its own,
  and a new export starts from what it carries. The page writes it after each answer that
  changed the file, and reopening the page continues from there.
- Device state, the approval of automatic actions included, is kept in the same database's
  `device` store. A carried file is a Duplicate, a new instance, so its automatic actions are
  approved afresh.
- The page asks for persistent storage. When the browser will not keep the working copy, the
  page says so as it starts: "This browser does not keep this file, so your changes last only
  this visit. Download the file to keep them." **Download file** says the same.
- **Download file** saves the working copy as a `.nendo` file under the carried name.
- Published on a web server, the page works the same when it is a folder's `index.html`.

## Apply changes

**Apply changes…** picks a downloaded working file (`.nendo`) and calls
`PrepareWebPageChangesAsync`, which opens it read-only and checks it before anything is
prepared:

| Refusal | When |
| --- | --- |
| `web-page-other-application` | It is a file of another application. |
| `web-page-not-exported-here` | No Duplicate transition in it names this file's instance; or this file was restored or replaced since the export, so its history no longer holds the export point. |
| `web-page-no-changes` | It holds no revision after the export point. |
| `web-page-changes-refused` | This file's validation refused the changes and named no one revision, or refused one too many times to prepare them (16 passes). |

Each revision after the export point is rebuilt from its stored operations into one mutation of
a proposal titled "Changes from {name}", under the origin `host.web-page`, the scope
`host.web-page/{page instance ID}` and the revision's own ID as its key. Only the operations its
author made are replayed: the page's automatic effects are left out, and this file's actions make
them again on the proposal's clone. An operation must rebuild to the same canonical form, or the
revision is left out. `identity.transition`, `data.restoreDeletedRecord` and `schema.removeChoice`
are never replayed; a picture is read from the page's file. A definition revision's expected
revision is shifted by the distance between the two files' definition lineages.

A revision is **left out**, with its reason, when:

- its records changed in this file since the export;
- it follows a left-out revision that wrote the same records;
- it is a design change and this file's design changed since the export, or it follows a
  left-out design change;
- it cannot be replayed exactly;
- this file's validation refuses it (`NPROP008`, a stale record version, reads as "Its records
  changed in {file} since the export.").

A revision an earlier Apply brought in, by scope and key, is skipped and counted. The notice says
what is ready, what was applied before and what was left out, for example "3 changes from
Station.nendo are ready to review. 1 change was applied before. 1 left out: …". Left-out revisions
are added to the proposal's review as `NPROP013` warnings. The proposal opens for review, and
nothing reaches the file until the person accepts it.

## Where the assertions live

| Behaviour | Assertion |
| --- | --- |
| The Duplicate carried before the module script, the size refusal, no replacement | `tests/Nendo.Session.Tests/WebPageExportTests.cs` |
| Arrival, stale and refused revisions left out, other files refused, pictures | `tests/Nendo.Engine.Tests/WebPageChangesTests.cs` |
| The notice's sentences | `tests/Nendo.Session.Tests/WebPageChangesNoticeTests.cs` |
| Exported Station and Deck open, edit, keep across a reload, download; refused storage; no network; the download applies back | `tools/Review-BrowserHost.ps1` with `tools/Gate-BrowserHost.mjs` and `tools/WebPageRoundTrip.cs`. The gate runs it in Edge from disk; `-Browser chrome` or `firefox`, `-Served` (a static site on a loopback port) and `-Page` (an installed page) run the same checks elsewhere. |
| The installed page is whole, carries a runtime and its licence notices | `tools/Test-NendoSetupIsolated.ps1` |
| Two builds of one runtime file in one page | `scripts/pack-browser-host.mjs` refuses to pack it |
