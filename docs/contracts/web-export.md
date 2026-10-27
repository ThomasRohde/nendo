# Web page export contract

This contract covers an application exported as one web page or as a web app: what Export
writes, what the page carries and keeps, how a web app keeps a visitor's changes across a
republish, and how Apply changes brings the page's edits back.

- **Decision:** [ADR-0035](../decisions/0035-an-app-exported-as-one-web-page.md) and
  [ADR-0037](../decisions/0037-an-exported-app-as-an-installable-web-app.md), on the browser
  host of [ADR-0036](../decisions/0036-nendo-runs-in-a-browser.md)
- **Code:** `src/Nendo.Session/NendoWebPageExport.cs` and `NendoWebAppExport.cs`;
  `src/Nendo.Engine/NendoWriteCoordinator.WebPage.cs`; `src/Nendo.Browser/BrowserHost.cs`'s
  `CarryOverAsync`; in the Desktop host, `MainPage.FileActions.cs`; in the Workbench,
  `host-browser.ts`, `web-app/sw.js` and `scripts/pack-browser-host.mjs`

## The command

**File → Web page…** (`file.webPage`, in the Copies section) opens a Nendo dialog with a choice,
**Export as** "One page" (the default) or "Web app", and two buttons: **Export…** and **Apply
changes…**. Apply changes is enabled while the file can be written. The entry is not offered by
the browser host itself.

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

## Web app

**Export…** with "Web app" picks a folder ("Export here"), then says what the app is before it
writes anything: the page's sentence, followed by "Publish the folder on a web server with
https, and browsers install it as an app." `NendoWebAppExport.ExportAsync` builds the page as
the one-page export does and writes the folder's files in a folder of its own inside it
(`.nendo-web-app-{id}.partial`), then moves them out:

| File | Holds |
| --- | --- |
| `index.html` | The exported page, with `<link rel="manifest">`, `<link rel="apple-touch-icon">`, `theme-color` and `application-name` added to its head before `<title>`. It still opens from disk. |
| `manifest.webmanifest` | `id` `./?nendo-application={application ID}`, `name` and `short_name` the file's name without `.nendo`, `start_url` and `scope` `./`, `display` `standalone`, `background_color` and `theme_color` `#f9f9fa` (the light `--canvas` token), and the two icons with purpose `any`. |
| `sw.js` | The service worker the payload ships as `WebPage/sw.js`, with `__NENDO_WEB_APP_VERSION__` replaced by the SHA-256 of `index.html`. |
| `icons/icon-192.png`, `icons/icon-512.png` | The file's look, drawn as its window icon is drawn; a picture that cannot be read falls back to its tone and letter. |

| Refusal | When |
| --- | --- |
| `web-app-folder-missing` | The folder does not exist. |
| `web-app-folder-not-empty` | The folder holds anything: "{folder} is not empty. Choose an empty folder for the web app." Nothing in it changes. |
| `web-page-runtime-missing` | The page runtime or the service worker is not installed. |

The page's own refusals (`file-too-large`, `unsupported-sync-location`) apply as well. The notice
says "Web app written to {folder}. Publish the folder on a web server with https, and browsers
install it as an app."

### Installing and updating

- The page registers `sw.js` only when it is served in a secure context (`https:` or a loopback
  address) and its head links a manifest. From disk it does neither.
- The service worker keeps exactly `index.html`, the manifest and the icons, in the cache
  `nendo-web-app {scope} {version}`, and answers a GET for those addresses (the folder's own
  address as `index.html`) from it, so the app opens without the network. It answers no other
  request. Activating removes the same scope's older caches and claims the open pages.
- A newer `index.html` published in the folder installs a newer worker, which waits. The page
  says "A newer version of this app is published." with **Reload**, and nothing is swapped in
  until the person chooses it. Reload waits for the working copy's last write, asks the waiting
  worker to take over, and reloads when it has.
- The page's content-security policy allows `img-src 'self'`, `worker-src 'self'` and
  `manifest-src 'self'`.

### The working copy across a republish

A web app's working copy is kept under `web-app:` and the app's address (the folder's URL), as
`{carried, bytes}`: the file and the digest of the export it came from. When the page carries
another export than the copy came from, `CarryOverAsync` opens the page's export and replays
the copy's changes onto it by the rules of [Apply changes](#apply-changes), the sibling rule
included, and promotes them:

| Outcome | When | The page |
| --- | --- | --- |
| carried | Every change came over. | "Your changes were carried to the newer version of this app." |
| carriedPartly | Some were left out. | "Your changes were carried to the newer version of this app, except one." (or "except N"), with each reason, and "Download previous copy keeps your copy as it was." |
| started | None could come over, or the copy is not of this source. | "This app starts again from its newer version, because your changes cannot be carried to it: {reason}" |
| kept | The page carries an older export than the copy's (`web-page-older-export`). | Keeps the copy: "This page carries an older version of this app than the copy this browser keeps, so your copy is kept." |
| readOnly | Another tab is editing the app. | Opens without keeping anything. |

After carriedPartly and started, the copy as it was is kept under `previous:` and the same key,
and **Download previous copy** in the file menu saves it. An approval of automatic actions
carries to the newer export when its automatic actions are exactly those approved
(`DesktopBehaviourGrantStore.IsGrantedIn`); otherwise the page asks again.

## Apply changes

**Apply changes…** picks a downloaded working file (`.nendo`) and calls
`PrepareWebPageChangesAsync`, which opens it read-only and checks it before anything is
prepared:

| Refusal | When |
| --- | --- |
| `web-page-other-application` | It is a file of another application. |
| `web-page-not-exported-here` | No Duplicate transition in it names this file's instance, or this file's own source when this file is itself an export; or this file was restored or replaced since the export, so its history no longer holds the export point. |
| `web-page-older-export` | It is a sibling exported from the same source after this file was: "{file} is an older export than {name}, so its changes are not carried to it." |
| `web-page-no-changes` | It holds no revision after the export point. |
| `web-page-changes-refused` | This file's validation refused the changes and named no one revision, or refused one too many times to prepare them (16 passes). |

When this file is itself an export (a web app's newer version carrying a visitor's copy over),
a working file exported from the same source at or before this file's export point is its
**sibling**, and its changes are prepared the same way. Its own identity transition is not one
of this file's changes, and the definition offset subtracts the one this file's own transition
made.

Each revision after the export point is rebuilt from its stored operations into one mutation of
a proposal titled "Changes from {name}", under the origin `host.web-page`, the scope
`host.web-page/{page instance ID}` and the revision's own ID as its key. A revision that was
itself carried from an earlier page keeps the scope and key it was first made with, so Apply
changes recognises it whichever export brings it. Only the operations its
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
| The web app folder: its files, the manifest, the stamped worker, the icons; a folder that is not empty is refused and left as it was | `tests/Nendo.Session.Tests/WebAppExportTests.cs` |
| A visitor's changes carry to a newer export of the same source and are applied once; an older export is refused | `tests/Nendo.Engine.Tests/WebPageChangesTests.cs` |
| Served web app: the worker controls the page, the browser's installability check, offline with the visitor's edit, a republished version offered and not swapped in, Reload, the carry-over with one change left out, Download previous copy, nothing outside the folder requested; the carried copy applies back | `tools/Review-BrowserHost.ps1 -Served` with `tools/Gate-WebApp.mjs`, in Edge or Chrome |
| The installed page is whole, carries a runtime and its licence notices; the installed service worker | `tools/Test-NendoSetupIsolated.ps1` |
| Two builds of one runtime file in one page | `scripts/pack-browser-host.mjs` refuses to pack it |
