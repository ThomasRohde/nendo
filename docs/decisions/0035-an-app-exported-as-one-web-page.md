# ADR-0035: An app exported as one web page

- **Status:** Accepted
- **Date:** 2026-10-26
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium-low
- **Evidence:** Pending. A prototype ran a view package in an opaque-origin frame from a page opened from `file://`, through the Workbench's own broker
- **Amends:** ADR-0001 (a copy that runs without Nendo), ADR-0013 (views in a page)
- **Depends on:** ADR-0001, ADR-0007, ADR-0010, ADR-0013, ADR-0036

## Context

A `.nendo` file holds a whole application, but someone without Nendo cannot open one. The
browser host ([ADR-0036](0036-nendo-runs-in-a-browser.md)) runs Nendo in a browser page with
nothing installed. An application can therefore leave Nendo as a page that opens itself: the
browser host with the file inside.

## Decision

Nendo exports an application as **one self-contained `.html` file**: the browser host with a
copy of the file embedded. It opens from disk in a current browser, with nothing installed and
no server.

### What the page is

- **Export → Web page** in the Desktop host writes the page where the person picks. The file
  inside is a Duplicate ([ADR-0010](0010-file-identity-duplicate-fork-backup-and-restore.md)):
  the same application, a new instance, made with the host's copy discipline. The page records
  the change sequence it was exported at.
- The page runs the real Engine. Calculations, automatic actions (after the approval the browser
  asks for, as Nendo does), commands, Studio, history and custom views work as in Nendo. Agent
  access does not exist in the page.
- The page's own code makes no network request. Linked media loads from its address, and a view
  keeps the network rule it has in Nendo.
- A file the browser host refuses (above its size limit) is refused at export, with its size
  named.

### Where edits go

- The page carries its file in a `nendo-file` script element, gzipped and base64, and opens it as
  it starts.
- The page keeps its working file in the browser's IndexedDB, keyed by a digest of the file it
  carries, so each exported page has its own and a new export starts from what it carries. It
  writes the working file after each answer that changed it. Reopening the page continues from
  there. The page asks for persistent storage. When the browser will not store the working file,
  the page says that edits are held for the visit only, and **Download file** says so too.
- **Download file** saves the page's working file as a `.nendo` file, which Nendo opens like any
  other.
- **Apply changes from a web page** in Nendo opens a downloaded working file of a page exported
  from this file. It checks the application ID and the export lineage, then replays the
  revisions committed after the export against the active file, at their base versions, as a
  proposal is promoted ([ADR-0007](0007-proposal-clone-validation-and-replay-promotion.md)). A
  revision whose records moved on in Nendo since the export is shown and left out. Nothing is
  applied that the active file's own validation refuses.

### Custom views in the page

- Each view runs in a sandboxed frame without `allow-same-origin` and without top-level
  navigation, so it has an opaque origin and no access to the page's storage or document.
- The page loads the view's package into the frame: each file becomes a blob URL inside the
  frame, relative module specifiers are rewritten onto one fixed base that an import map sends to
  those blobs, `fetch` of a package path is answered from them, and the entry document is written
  in place. `/_nendo/api.js` is the view API, which talks to the page's broker over a
  `MessagePort` with the same closed method table as in Nendo. The broker accepts the frame's
  opaque origin only from a frame it mounted.
- The page's content-security policy allows `blob:` for scripts, styles and connections, since a
  frame written from the page inherits it.
- Per-view origins, and with them a view's own browser storage across visits, do not exist in a
  page. A package whose files the page cannot load is shown with that reason.

### What the page is not

- Not the file it came from. It is a duplicate, and its edits reach the original only through
  Apply changes, validated by Nendo.
- Not an MCP client or server.

## Consequences

### Positive

- An application can be sent to anyone and opened with a double-click, offline, on any operating
  system with a current browser, and behaves as it does in Nendo.
- The same page can be published as a static site by naming it `index.html`.
- Edits come back as the typed operations the page's Engine recorded, so Nendo validates and
  replays them like any other change.

### Negative

- The page carries the .NET runtime and the Engine: several MB before the file.
- Browsers keep storage for `file://` pages differently: some share one origin across every
  local file, others isolate each. Edits held for the visit only are possible and must be
  visible.
- A view that depends on its own origin's storage loses it between visits.
- Every record in the file is in the page. Exporting is publishing that data to whoever receives
  the file.

## Rejected alternatives

- **A static client over a snapshot of the compile result:** a second implementation of the query
  rules, with frozen calculations and no automatic actions.
- **A folder of files (a static site):** a single file can be emailed and opened from disk, and it
  serves as a site's `index.html` as it is.
- **Edits back by CSV import:** import only creates records, so every edited record would come
  back twice.

## Revisit triggers

- Pages need agent access (WebMCP).
- Views need their own storage across visits in a page.
- Exported files regularly approach the browser host's size limit.
