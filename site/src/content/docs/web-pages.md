---
title: Web pages
description: Export an application as one web page that opens in any browser with nothing installed, publish it as a web app people install, and bring the changes made in it back into the file.
group: Use
order: 55
---

Nendo can export an application as **one `.html` file**. Whoever you send it to opens it in a
browser, on any operating system, with nothing installed and no server. The page runs the same
Engine as Nendo, so screens, calculations, automatic actions, commands, Studio, history and custom
views all work as they do in Nendo. Edits made in the page can come back into your file, where you
review them before anything changes.

## Export a page

1. Open the file in Nendo, and choose **File → Web page… → Export…**.
2. Pick where the page goes. Nendo offers the file's name with `.html`, and never replaces a file
   that is already there.
3. Nendo says what the page holds before it writes it: **a copy of every record in the file**.
   Anyone who has the page can read them. Choose **Export**.

The file you have open does not change. The page holds a Duplicate of it: the same application, a
copy of its own, made the way **Duplicate…** makes one (see
[Files and data](/nendo/docs/files-and-data)). Exporting needs no network: the page's runtime
comes with Nendo.

A file over 256 MiB is refused, and the message says how large it is. The page itself starts at
about 10 MB, the size of the runtime it carries, plus your file compressed.

## Use a page

Double-click the `.html` file. The page opens the file it carries.

- **Automatic actions** ask for approval first, as they do the first time Nendo opens a copy. Open
  **Health** and approve them. The approval is kept for the next visit.
- **Edits are kept in the browser.** The page writes its working copy to the browser's storage after
  every change, and the next visit carries on from there. Each exported page keeps its own copy,
  and a page exported again starts from what it carries.
- **Download file** in the file menu saves the working copy as a `.nendo` file. It opens in Nendo
  like any other.
- When the browser will not keep anything, the page says so as it opens: changes last only this
  visit, and **Download file** keeps them. A private window keeps the copy only until it closes.
- Pictures stored in the file are shown from the page. Pictures linked from the web load from
  their addresses.

What the page does not have: agent access, a view's own browser storage across visits, and more
than one tab writing at a time. A second tab on the same page opens it read-only.

## Publish a page

The same file works on a web server. Name it `index.html`, or put it in a folder of its own as
that folder's `index.html`, and upload it to any static host. Each visitor gets their own working
copy in their own browser; nothing they change reaches the server or the other visitors.

## Publish as a web app

A web app is the same page as a folder for a web server, which browsers install as an app and open
without the network.

1. Choose **File → Web page…**, select **Web app**, and choose **Export…**.
2. Pick an empty folder. Nendo writes the page as `index.html`, with a manifest, a service worker
   (`sw.js`) and two icons drawn from the file's look.
3. Upload the folder to a static host that serves `https`.

Visitors open the folder's address. Edge and Chrome offer to install it, and it then opens in a
window of its own, offline too. Opened from disk, `index.html` works as a plain page.

**Publishing a newer version.** Export again into an empty folder and upload it over the old one.
Visitors with the app open are told a newer version is published, and **Reload** moves to it; the
page is never swapped under them. Their own changes are carried over to the newer version, by the
same rules as **Apply changes**: a change to records you changed in the meantime is left out, and
the page says so. **Download previous copy** in the file menu then saves their copy as it was. A
page older than the visitor's copy never replaces it.

## Bring changes back

When someone sends you the file their page downloaded:

1. Open the file the page was exported from, and choose **File → Web page… → Apply changes…**.
2. Pick the downloaded `.nendo` file.

Nendo checks that the download came from a page exported from this file, then prepares the
page's changes as one proposal and opens it for review. Nothing changes until you accept it.

- Each change made in the page is replayed as it was made: the same records, the same values. Your
  file's own automatic actions run again on the proposal, so their effects are your file's.
- A change is **left out**, with its reason, when its records changed in your file since the
  export, when it follows a left-out change to the same records, when it changes the design and
  your design changed too, or when your file refuses it. The notice and the proposal's review list
  each one.
- Applying the same download twice brings nothing in twice: changes applied before are counted
  and skipped. That holds across a web app's versions too: a download from a newer version
  applies to your file, and changes you applied from an earlier one are skipped.
- A file from another application, a page exported from a different file, or a file restored from
  a backup since the export is refused with a sentence that says which.

## Licences

The page carries Nendo, the .NET runtime, SQLite and the open-source packages Nendo is built on.
Their licences travel inside the page, so a page you send on carries them with it. They are in the
page's source, in the element `nendo-notices`.
