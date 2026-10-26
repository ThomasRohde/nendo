# ADR-0035: An app exported as one web page

- **Status:** Accepted
- **Date:** 2026-10-26
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium-low
- **Evidence:** Pending
- **Amends:** ADR-0001 (a copy that runs without Nendo), ADR-0013 (views in an exported page)
- **Depends on:** ADR-0001, ADR-0004, ADR-0008, ADR-0013, ADR-0027, ADR-0031

## Context

A `.nendo` file holds a whole application, but it runs only in the installed Windows host.
Someone without Nendo, or on another operating system, cannot open a deck, a manuscript or a
tracker that a Nendo user sends them. The application is already data: the Engine compiles a
file's definitions into plans and surfaces, and the Workbench draws those through one request
protocol that an in-memory host already answers in an ordinary browser for its preview.

Running the Engine itself in a browser would keep one authority over the file, at the cost of
a large download, save-in-place in only some browsers, and a virtual file system under the
write coordinator. That route is a separate decision. This one lets an application leave
Nendo as a page anyone can open, without forking the compiler and without giving the page any
authority over a `.nendo` file.

## Decision

Nendo exports an application as **one self-contained `.html` file** that runs in a current
browser with nothing installed. The page is a copy of the application at the moment of export,
not a client of the file it came from.

### The Engine compiles, the page runs

- **Export → Web page** in the Desktop host writes the file where the person picks. The Engine
  assembles the snapshot through typed reads: the manifest and look, every record type's schema,
  the compiled plans and surfaces, every record with its version and its calculated values, the
  view packages' files and the help pages ([ADR-0027](0027-a-file-carries-its-own-help.md)).
  Skill packages are left out.
- The page never compiles a definition. It holds the export runtime, built by the Workbench as
  its own bundle, and the snapshot as embedded JSON. Everything the page needs is inside it.
- The export runtime is the Workbench's markup and interaction code behind a static host that
  answers the same `WorkbenchClient` request protocol. Filtering, sorting, search and
  aggregates follow the Engine's query rules, and a conformance lane runs the same query cases
  through both and compares the answers.
- The page shows the semantic surfaces (lists, boards, calendars, outlines, record pages,
  forms, tiles and charts), the custom views, Help, and Studio's data tables. The tables read and
  edit data and change no schema. They stay reachable however a view fails, so the data is
  usable before any specialised presentation, as in Nendo.
- The page's own code makes no network request. Linked media loads from its address, and a view
  keeps the network rule it has in Nendo.

### What an export refuses, by name

Export refuses an application the page cannot run faithfully, and names the reason, as the
compiler names its codes:

- A file with automatic actions ([ADR-0008](0008-general-scripting-and-capability-isolation.md)).
  An action that silently did not run would leave data its rules forbid.
- A file whose embedded content would take the page past 64 MiB.

Inside an exported page:

- Calculated values are the ones exported. A record edited in the page shows its calculated
  values marked as from the export.
- A declarative command whose steps only set fields runs. A command with any other step is
  shown disabled with *Runs in Nendo*.
- Proposals, history, compensation, agent access and launched agents do not exist. A view's
  call to one of them is refused with the method's name.

### Edits stay in the browser and return as changes

- A person's edits are an overlay in the browser's IndexedDB, keyed by application ID and record
  ID, each holding the record's values and the version it was based on. The page asks for
  persistent storage, and says so when the browser refuses and edits are held for the visit only.
- A page published on a shared origin shares storage with other pages there, so every key starts
  with the application ID.
- A later export of the same application keeps the overlay's edits whose record type and fields
  still exist. Edits it cannot place are listed, never dropped.
- **Download changes** writes a changes file: the application ID, the export's snapshot digest,
  and each create, update and delete with its record ID and base version. In Nendo, **Apply
  changes from a web page** checks the application ID and applies each change as a typed write
  at its base version. A change whose record has moved on since the export is shown and left
  out. The changes enter through the same services and validation as every other write.
- The page also downloads each record type as CSV for use elsewhere. CSV import creates records
  and does not carry edits back.
- The page never writes a `.nendo` file and holds no handle, lease or path to one.

### Custom views in the page

- Each view runs in a sandboxed frame without `allow-same-origin` and without top-level
  navigation, so it has an opaque origin and no access to the page's storage or document.
- The page gives the frame its package's files from the snapshot. A relative path resolves only
  inside the view's own package, and `/_nendo/api.js` is the export runtime's view API. The view
  API talks to the page's broker over a `MessagePort`, as in Nendo, with the same closed method
  table.
- Per-view origins, and with them a view's own browser storage across visits, do not exist in an
  exported page. A view's data writes go to the overlay like any other edit. A package whose
  files the page cannot load is shown with that reason, and the rest of the page still works.

### What the page is not

- Not a canonical artefact ([ADR-0001](0001-local-one-file-product-boundary.md)). It is a copy,
  like a CSV export, and it carries the data it was exported with.
- Not an MCP client or server. Agents reach the application in Nendo.
- Not a second authority. Its validation guards what it draws, and Nendo validates every change
  again when it is applied.

## Consequences

### Positive

- An application can be sent to anyone and opened with a double-click, offline, on any
  operating system with a current browser.
- The same page can be published as a static site by naming it `index.html`.
- The compiler and the Engine stay single. The page reuses the Workbench's drawing code, so a
  surface looks the same in both.

### Negative

- The page is a second runtime of the query rules and the view API. It needs the conformance
  lane to stay honest, and every new request method needs a static answer or a named refusal.
- Calculated values and automatic actions do not run in the page, so files that rely on them
  export with frozen values or are refused.
- Browsers keep storage for `file://` pages differently: some share one origin across every local
  file, others isolate each. Edits held for the visit only are possible and must be visible.
- A view that depends on its own origin's storage loses it between visits.
- Every record in the file is in the page. Exporting is publishing that data to whoever receives
  the file.

## Rejected alternatives

- **The Engine in the browser for the export:** one authority, but several MB of download and a
  virtual file system for a page meant to be sent like a document. It is a separate decision for
  running Nendo itself in a browser.
- **A folder of files (a static site):** a single file can be emailed and opened from disk, and
  it serves as a site's `index.html` as it is.
- **A read-only snapshot:** cheapest, but not an application.
- **Edits back by CSV import:** import only creates records, so every edited record would come
  back twice.

## Revisit triggers

- Nendo runs in a browser with its own Engine, which would make the export runtime redundant.
- Files that rely on automatic actions or calculations need to work after export.
- A browser standard lets a page reach an agent (WebMCP), and the page should offer its records
  to one.
- Views need their own storage across visits in an exported page.
