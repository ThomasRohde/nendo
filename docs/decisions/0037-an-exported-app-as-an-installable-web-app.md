# ADR-0037: An exported app as an installable web app

- **Status:** Accepted
- **Date:** 2026-10-27
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The browser host lane's served run (`Review-BrowserHost.ps1 -Served`, `Gate-WebApp.mjs`) in Edge and Chrome: installable by the browser's own check, offline, a republished version offered and moved to with Reload, a visitor's changes carried over with one left out, and the carried copy applied back to the source
- **Amends:** ADR-0035 (a second export form; the working copy across a republish)
- **Depends on:** ADR-0007, ADR-0010, ADR-0035, ADR-0036

## Context

An exported page ([ADR-0035](0035-an-app-exported-as-one-web-page.md)) opens from disk and from
a web server. Published on a server, people return to it as they return to a site: it has no
place among their apps, it does not open without the network, and a newer export published in
its place starts every visitor over from the file it carries.

Browsers install a site as an app and open it offline when it has a web app manifest and a
service worker. Neither works from `file://`, and a service worker must be a script of the
site's own, so the one-file page cannot carry them.

## Decision

Nendo exports an application in a second form, **a web app**: a folder for a static web server
that browsers install as an app and open offline. The one-file page is unchanged.

### The folder

**File → Web page…** offers both forms under **Export…**: one page, or a web app. The web app
goes into a folder the person picks, which must be empty. It holds:

| File | What it is |
| --- | --- |
| `index.html` | The exported page as the one-file form writes it, with a link to the manifest and the icon added to its head. It still opens from disk. |
| `manifest.webmanifest` | The app's name (the file's name), an `id` from the application ID, `start_url` and `scope` `./`, `display: standalone`, and colours from the light theme's tokens. |
| `sw.js` | The service worker, shipped with Nendo beside the page runtime. |
| `icons/icon-192.png`, `icons/icon-512.png` | The file's look, drawn as its Windows icon is drawn. |

Nothing else is written, and nothing in the folder names the computer it was exported from.

### The service worker

- The page links the manifest and registers the service worker only when it is served from
  `https:` or from `localhost`, and finds the manifest beside it. From disk it does neither.
- The service worker keeps exactly the folder's files, in a cache named by the page's digest,
  and answers those addresses from it, so the app opens without the network. It answers no
  other request: a linked picture and a view's own requests go to the network as before.
- A newer page published in the folder installs a newer service worker beside the running one.
  The page says so, with **Reload**; nothing is swapped under an open file. Reload moves to the
  new version.
- The page asks for persistent storage, as it does from disk.
- The page's content-security policy allows `manifest-src 'self'` and `worker-src 'self'` for
  these two files.

### The working copy across a republish

A web app keeps one working copy per application at its address, rather than one per carried
file, so publishing a newer export in the same folder does not start its visitors over.

- When the page carries a newer export of the same source file than the working copy came from,
  the page carries the visitor's changes over: it opens the new export and replays the
  revisions the visitor made, by the rules of Apply changes
  ([ADR-0035](0035-an-app-exported-as-one-web-page.md)): only the visitor's own operations, and
  a revision left out, with its reason, when its records changed in the source between the two
  exports, when it follows a left-out revision on the same records, when it is a design change
  and the design changed, or when validation refuses it. A revision the source already holds
  through Apply changes is not replayed again.
- The two exports are siblings: each is a Duplicate of the same source instance, and the newer
  one's export point is at or after the older one's. That is the only lineage the page accepts
  for carrying changes over.
- An export older than the working copy's never replaces it; the page keeps the working copy and
  says so.
- An export of another source, or one whose changes cannot be carried, starts from what it
  carries, and the page says why.
- Whenever the page leaves something out or starts over, it keeps the previous working copy in
  this browser, and **Download previous copy** in the file menu saves it.
- An approval of automatic actions carries to the newer export when its automatic actions are
  exactly those approved. Otherwise the page asks again, as for any file, and the visitor's
  changes are carried without the automatic effects until it is approved.
- **Apply changes** in Nendo accepts a working copy carried across a republish: its export point
  is the newer export's, which names the same source.

## Consequences

### Positive

- An application can be published once and used like an installed app, offline, with each
  visitor's edits kept on their own device across updates.
- Republishing is how an application's owner ships changes to everyone who uses it.

### Negative

- A web app needs a web server with `https:`; the folder is not a single file to send.
- A visitor's copy and the published app can drift apart; what cannot be carried over is left
  out and named, not merged.
- An installed app still keeps its data in the browser's storage, which the browser or the
  visitor can clear. Download file stays the only copy outside the browser.

## Rejected alternatives

- **A manifest in the one-file page, as a blob URL:** installable in Chromium only, and never
  offline, since a service worker must be a script of the site's own.
- **Nendo itself as an installable web app that opens any `.nendo` file:** the general browser
  host, not an exported application; a separate decision.
- **A service worker that also caches linked pictures and views' requests:** it would keep
  content the file only links to, and decide for a view what its network rule is.

## Revisit triggers

- Visitors need their edits back in the published app without the owner applying them.
- Browsers support service workers from `file://`.
- A view needs its own storage across visits in an installed app.
