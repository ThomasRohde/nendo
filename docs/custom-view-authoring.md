# Authoring a custom view

This guide tells how to write a Nendo custom view, put it in a `.nendo` file and
show it. The [custom-view contract](contracts/custom-views.md) states every rule
this guide depends on. If this guide, the contract and the code disagree, the code
is current: fix the contract and this guide to match it. The authority is
[ADR-0013](decisions/0013-custom-views-with-code-in-the-file.md), accepted
2026-09-25.

A custom view is a small web page that draws a file's records in a way Nendo's own
screens cannot: a graph, a Gantt chart, a map. Its code lives in the `.nendo` file
as a **package**. A view that is shown runs, inline in Nendo, in a frame of its own.
There is nothing to install and nothing to allow.

This repository has four worked examples. All are MIT-licensed and have no
dependencies:

- [`extensions/dependency-graph/`](../extensions/dependency-graph/README.md), a
  general record graph;
- [`extensions/work-dependencies/`](../extensions/work-dependencies/README.md), the
  planner's own dependency view;
- [`extensions/systems-lens/`](../extensions/systems-lens/README.md), the Nendo
  Station schematic;
- [`extensions/gantt/`](../extensions/gantt/README.md), a record set on a time line,
  which also works on a record page.

## What a view can do

A view is a web page with most of a web page's powers. It can use the network,
loopback included, the clipboard, browser storage, workers, WebAssembly, fonts,
images and any other file it carries. It reads the file through `window.nendo`:
records with their calculated fields and exact numbers, the schema, and the file's
changes as they happen. It can ask Nendo to open a record, a screen or Studio, show
a sentence, and size its own panel.

**Not yet.** A view writes records and runs record commands (see
[Changing records](#changing-records)) and proposes changes to the app (see
[Proposing a change](#proposing-a-change)). Keeping state in the file arrives with
the rest of Phase 3. A view as a screen of its own (`extensionView`)
or a tile on the front page (`extensionTile`) arrives with Phase 5.

A view can never reach the Workbench's own page, the host bridge, SQL, a file path,
another file or a device setting, and it can never accept a proposal. See
[What a view can and cannot reach](#what-a-view-can-and-cannot-reach).

## A first view

A package is a folder. This one lists the records its view is about, and opens one
when you select it. It has four files.

`nendo-package.json`:

```json
{
  "packageId": "org.example.record-list",
  "title": "Record list",
  "version": "0.1.0",
  "entryPoint": "index.html",
  "description": "Lists the view's records and opens the one you select."
}
```

`index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Record list</title>
  <link rel="stylesheet" href="view.css">
</head>
<body>
  <main id="content">
    <h1 id="summary">Waiting for Nendo…</h1>
    <ul id="records"></ul>
  </main>
  <script src="/_nendo/api.js"></script>
  <script src="view.js"></script>
</body>
</html>
```

`view.css`:

```css
body {
  margin: 0;
  padding: 16px;
  font: 14px/1.5 system-ui, sans-serif;
  color: var(--nendo-ink, #13213d);
  background: var(--nendo-surface-raised, #ffffff);
}
h1 { margin: 0 0 8px; font-size: 16px; }
ul { margin: 0; padding: 0; list-style: none; }
button {
  padding: 2px 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--nendo-cobalt, #2458e6);
  cursor: pointer;
}
```

`view.js`:

```js
(async () => {
  'use strict';
  const nendo = window.nendo;
  const summary = document.getElementById('summary');
  const list = document.getElementById('records');
  if (nendo === undefined) {
    summary.textContent = 'This view runs inside Nendo.';
    return;
  }

  let context;
  try {
    context = await nendo.ready;           // the Workbench has connected this frame
  } catch (error) {
    summary.textContent = error.message;   // not-framed: the page was opened on its own
    return;
  }
  document.documentElement.lang = context.locale;

  // A record's label as text: a reference's target label, a number's exact digits,
  // or the value itself.
  function label(record) {
    const fieldId = nendo.context.bindings.labelFieldId;
    const value = fieldId === null ? null
      : record.labels[fieldId] ?? record.exact[fieldId] ?? record.values[fieldId];
    return value === null || value === undefined ? record.recordId : String(value);
  }

  let latest = 0;
  async function read() {
    const number = ++latest;
    let records;
    try {
      records = await nendo.view.loadRecords();
    } catch (error) {
      summary.textContent = `The records could not be read: ${error.message}`;
      return;
    }
    if (number !== latest) return;         // a newer read has started since
    summary.textContent = `${records.length} ${records.length === 1 ? 'record' : 'records'}`;
    list.replaceChildren(...records.map((record) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label(record);  // text, never markup
      button.addEventListener('click', () => {
        nendo.ui.openRecord(record.entityId, record.recordId).catch((error) => {
          summary.textContent = error.message;
        });
      });
      const item = document.createElement('li');
      item.append(button);
      return item;
    }));
  }

  // The file changed, or the view's definition did: read again, once for a burst.
  let pending = null;
  function schedule() {
    if (pending !== null) return;
    pending = setTimeout(() => { pending = null; read(); }, 250);
  }
  nendo.on('changes', schedule);
  nendo.on('context', schedule);
  await read();
})();
```

To see it run, [put the package in a file](#put-the-package-in-a-file) and
[show it](#show-it-the-view-definition) with an `extensionRecordsSurface` whose
`packageId` is `org.example.record-list`.

## The package folder

### `nendo-package.json`

The manifest names the package. It is a JSON object of at most 64 KiB. Comments and
trailing commas are allowed, and other keys are ignored.

| Key | Rule |
| --- | --- |
| `packageId` | Required. 3–80 characters, lowercase, at least two dotted segments, each starting with a letter and holding only letters, digits and `-`, such as `org.example.map`. It is the package's stable name |
| `title` | 1–200 characters. Default: the package ID |
| `version` | Optional. A semantic version such as `1.0.0`, at most 40 characters |
| `entryPoint` | Default: `index.html`. It must be one of the package's files |
| `description` | Optional. At most 1,000 characters |

The file never stores the manifest as a file: the package row holds what it says.
Exporting a package writes it again.

### Files

Every other file in the folder is part of the package, of any type. When the
folder is read, these are left out: hidden and system files, links, and any path
with a segment that starts with `.` or is `node_modules`. So a `.git` folder and a
`node_modules` folder stay behind. No build step is needed, and a bundler's output
folder works as well.

- A path uses letters, digits, `_ - . ~` and `/`, at most 240 characters. A path
  cannot start with `_nendo/`, which is reserved on every view's origin. Two paths
  may not differ only in case.
- A file holds at most 4 MiB, a package 512 files and 16 MiB, and a `.nendo` file
  64 packages and 64 MiB of package bytes. One change set brings at most 4 MiB of
  new content.
- The media type comes from the extension: `.html` is `text/html`, `.js` and `.mjs`
  are `text/javascript`, `.css`, `.json`, `.svg`, `.png`, `.woff2`, `.wasm` and more
  have their own, and an unknown extension is `application/octet-stream`. Nendo
  serves every file with `X-Content-Type-Options: nosniff`, so the browser runs a
  script only when its type is JavaScript. Give scripts a `.js` or `.mjs`
  extension; `.ts` is stored as `text/plain` and does not run.

## The API: `window.nendo`

### Load it

Put `<script src="/_nendo/api.js"></script>` before your own scripts. Every view
origin serves it from the installed Nendo, not from your package, so a view always
talks to the Nendo it runs in. It defines `window.nendo` and nothing else. The
script says hello to the Workbench, and the Workbench connects it over a private
`MessageChannel`. The contract describes that
[handshake and its messages](contracts/custom-views.md#the-view-api), but a view
never needs to speak them itself.

### Wait for `nendo.ready`

`await nendo.ready` resolves with the view's **context** once the Workbench has
connected the frame. A page opened on its own, outside any frame, is told so:
`nendo.ready` rejects with `not-framed`, and so does every call. `nendo.context`
always holds the latest context.

| Key | Holds |
| --- | --- |
| `viewId` | The view's node ID in the file |
| `kind` | `extensionGraphSurface`, `extensionRecordsSurface` or `extensionRecordPanel` |
| `placement` | `screen`, or `recordPage` for a panel on a record page |
| `title`, `packageId` | The view's title, and the package it runs |
| `entityId` | The record type the view is about |
| `recordId` | On a record page, that page's record; otherwise null |
| `bindings` | `labelFieldId`, `statusFieldId`, `edgeEntityId`, `sourceFieldId`, `targetFieldId`; `fields`, the further fields the definition names, each `{fieldId, entityId}`; `filters`, each `{fieldId, entityId, operator, value, valueKind}` |
| `configuration` | The definition's configuration, parsed. `{}` when there is none |
| `theme` | `{mode, tokens}`, the person's theme |
| `locale` | The browser's language |
| `readOnly` | True when the open file does not accept edits |
| `methods`, `apiVersion` | Every method the Workbench answers, and `1` |

The definition decides what a view is about, and the context passes it on. The
bindings are not permissions: a view can read any record type in the file.
`nendo.has(name)` says whether the Workbench answers a method, so a view can use a
method added later where it exists.

## Reading records

### The view's own records

- `nendo.view.loadRecords()` reads the records the view is about: its record type
  under its definition's filters, with `today` and `now` resolved as it reads, up to
  10,000 records. On a record page it reads that page's one record.
- `nendo.view.loadGraph()` reads a graph view's records as nodes and its link
  records as edges, and answers `{nodes, edges, fields, hiddenEdges}`:
  - a node is `{id, label, status, values, record}`. `label` is the label field as
    text: a reference's target label, a choice's display name or a number's exact
    digits. `status` is the status field's value;
  - an edge is `{id, source, target, values, record}`, pointing from the record its
    source reference names to the one its target names;
  - `values` holds the fields the definition binds on that record type, and
    `record` is the whole record;
  - `fields` names each bound field with its record type, display name and storage
    kind;
  - an edge whose source or target is not among the nodes, because a filter left
    it out or it points nowhere, is not in `edges`. `hiddenEdges` counts them. Say
    so, rather than draw a graph that looks complete.

### Any records

The `nendo.records` calls read any record type in the file, through the same
bounded reads the Workbench uses:

```js
const page = await nendo.records.query({
  entityId: 'task',
  filters: [{ fieldId: 'taskState', operator: 'ne', value: 'done' }],
  sortFieldId: 'taskStarts',
  limit: 50,                                // 1-200, 100 by default
});
// page.items are records; pass page.nextCursor as `cursor`, with the same query,
// for the next page. It is null on the last page.

const one = await nendo.records.get('task', 'task-42');          // a record, or null
const open = await nendo.records.count({ entityId: 'task', filters: [] });
const hours = await nendo.records.aggregate({ entityId: 'task', aggregate: 'sum', fieldId: 'taskEstimate' });
// hours.value is a number; hours.valueLexeme keeps its exact digits.
const all = await nendo.records.queryAll({ entityId: 'task' }, { max: 5000 });
```

- A filter is `{fieldId, operator, value}`. The operators are `eq`, `ne`, `lt`,
  `le`, `gt`, `ge`, `contains`, `isNull` and `isNotNull`; the last two take no
  value. A query carries at most eight filters. A choice compares by its option
  ID. A query cannot filter or sort by a calculated field.
- `records.groupAggregate`, `records.bucketAggregate` and `records.cellAggregate`
  answer the grouped, date-bucketed and crossed totals that Nendo's own charts
  draw. `aggregate` is `count`, `sum`, `min` or `max`, and `avg` is refused. The
  vocabulary, `nendo://application/vocabulary`, publishes the closed `bucket` and
  `range` words.
- `records.queryAll(query, {max})` follows the cursor to the end, 200 records at a
  time, up to `max` (10,000 by default). If the file changes between pages, it
  reads again from the top, at most three times.

A **record** is:

| Key | Holds |
| --- | --- |
| `entityId`, `recordId`, `version` | Its record type, its ID and its record version |
| `values` | Plain JSON by field ID. A number is a number, a choice is its option ID, a reference is the target record's ID, and a calculated field is its value, or null |
| `exact` | The exact digits of every number, stored or calculated. A JavaScript number can round a decimal; this cannot |
| `labels` | For each reference, the label of the record it points at |
| `calculated` | Each calculated field's `state` (`value`, `empty`, `error` or `pending`), `value`, `exact` and error |

Show a number from `exact` when its digits matter.

### The schema

`nendo.schema.describe()` answers what the file is: its `purpose`, its
`changeSequence`, each record type with its fields, and its screens and commands. A
field carries its `displayName`, its `storageKind`, whether it is `required` or
`calculated`, a calculated field's formula as `expression`, a choice field's
`choices` (`{id, displayName, retired, tone}`), a reference's target, and a
rating's scale. Retired record types and fields are left out. Use it to name the
fields a view shows and to turn a choice's ID into its name.

## Following the file

`nendo.on(name, listener)` subscribes to one of three events and returns a function
that unsubscribes:

| Event | Data | When |
| --- | --- | --- |
| `changes` | The file's change sequence | When anything commits to the open file, from anyone: at most once every 250 ms, carrying the latest sequence |
| `context` | The context | When the view's context changes, for example after its definition changed |
| `theme` | `{mode, tokens}` | When the person switches between light and dark |

An event is a nudge, not data. Read again what your view shows, and collapse a
burst into one read, as the first view does. `nendo.changes.subscribe(listener)`
is the same as `nendo.on('changes', listener)`.

When the view's package changes, because a proposal that changes its code was
accepted, Nendo starts the view again on the new code. A redraw of the page around
a view does not reload it.

## Colours and the theme

The API sets the Workbench's colours on your document's root as custom properties,
and keeps them current: `--nendo-canvas`, `--nendo-surface`,
`--nendo-surface-raised`, `--nendo-surface-soft`, `--nendo-ink`, `--nendo-muted`,
`--nendo-line`, `--nendo-line-strong`, `--nendo-cobalt`, `--nendo-cobalt-soft`,
`--nendo-violet`, `--nendo-healthy`, `--nendo-warning`, `--nendo-danger`,
`--nendo-shadow`, and the eight choice tones `--nendo-tone-red`,
`--nendo-tone-orange`, `--nendo-tone-amber`, `--nendo-tone-green`,
`--nendo-tone-teal`, `--nendo-tone-blue`, `--nendo-tone-violet` and
`--nendo-tone-grey`. It also sets `data-nendo-theme` on the root to `light` or
`dark`, and adds a `color-scheme` meta element after any of yours.

A view that draws with these follows the person's theme without listening for it.
Give each token a fallback, as `view.css` does, for a page that runs without Nendo.
A choice's `tone` in the schema names one of the eight tones, so a status drawn in
`--nendo-tone-‹tone›` reads as the same status it is elsewhere in Nendo. Do not use
`prefers-color-scheme`: it follows Windows, and a person can choose Light or Dark in
Nendo against it. `nendo.ui.theme` and the `theme` event carry the same mode and
values, for a canvas or a chart library that needs them in JavaScript.

## Acting for the person

- `nendo.ui.openRecord(entityId, recordId)` opens a record. On a Use screen of that
  record type, the record opens beside the view, which keeps running. A record of a
  type that Use does not show opens in Studio's Data view.
- `nendo.ui.openScreen(surfaceId)` shows a screen in Use, named by its root node ID
  as `schema.describe` lists it, or by its surface. The front page is a screen too.
- `nendo.ui.openStudio(entityId)` opens Studio's Data, on one record type when you
  name it.
- `nendo.ui.toast(text)` shows one sentence in Nendo's outcome line, as
  "‹view title›: ‹text›": 1–300 characters, at most one a second.
- `nendo.ui.setHeight(pixels)` sets the height of a panel on a record page, between
  80 and 4,000 pixels. A panel starts at 360. A view on a screen fills the screen's
  area, and `setHeight` answers the height it has.

The navigation calls follow the rules a click follows. While another action runs,
or while a record page holds unsaved typing, they are refused, and nothing moves.

## Changing records

A view changes records the way a person's edit does: through the same typed
operations, checked against the record's version, and recorded in History under
your package's name, `extension:‹package›`, where the person can undo it. Nendo
draws no confirmation. If an act needs one, ask the person yourself.

```js
const task = await nendo.records.get('tasks', 't1');
const updated = await nendo.records.update(task, { title: 'Pour the base', estimate: 12.5 });
const done = await nendo.commands.run('page.done', updated);   // a command from schema.describe
const added = await nendo.records.create('tasks', { title: 'Cure the slab' });
await nendo.records.delete(added);
```

- Each call takes the record as you last read it, `{entityId, recordId, version}`,
  and answers the record as it now stands, with its new version. Keep that one for
  the next write. `delete` answers null.
- If somebody changed the record since you read it, the write is refused and nothing
  changes. Read it again and decide.
- A value is null, text, true or false, a number, or `{ $nendoNumber: '12.50' }` for a
  decimal whose digits a JavaScript number would not keep. Read exact digits from a
  record's `exact`.
- `nendo.has('records.update')` tells you whether this Nendo lets views write. A
  file open read-only refuses every write with `read-only`.
- Record commands are the ones `schema.describe` lists under `commands`, by `id`.

### Proposing a change

A view can ask for a change to the app itself, such as a field it needs or a new
screen, and the person decides. It sends canonical operations, the same ones an agent
sends (`nendo://application/vocabulary` lists them), and Nendo opens its ordinary
review at once, saying which view asked.

```js
const asked = await nendo.proposals.prepare('Add a due date', [{
  operationType: 'schema.addField',
  payload: { entityId: 'tasks', fieldId: 'due', displayName: 'Due', storageKind: 'date',
    required: false, presentation: 'date', options: [] },
}]);
// asked: { proposalId, title, state: 'previewable', diagnostics: [], opened: true }
const later = await nendo.proposals.get(asked.proposalId);   // 'active' once accepted
```

- Your view keeps running while the review is open, and the person comes back to it.
  Follow the outcome with `proposals.get`, or listen to `changes`: an accepted
  proposal commits like any other change.
- A proposal the file cannot take comes back `invalid`, with `diagnostics` that say
  why, and the review shows them too.
- One proposal of your package waits at a time. Asking again while one waits is
  refused with `proposal-waiting`, and the message names it; `proposals.open(id)`
  opens it again.
- You cannot accept or reject. That is the person's.
- `opened` is false when Nendo could not open the review then, because another
  action was running or a record page held unsaved typing. Call `proposals.open`
  later.

To fit a panel to its content, measure the content, not the document, which is
always at least as tall as the frame:

```js
if (context.placement === 'recordPage') {
  const content = document.getElementById('content');
  new ResizeObserver(() => {
    nendo.ui.setHeight(Math.ceil(content.getBoundingClientRect().height) + 32).catch(() => {});
  }).observe(content);
}
```

## When a request is refused

A refused call rejects with a `nendo.NendoError`. Its `code` is stable, and its
`message` is a sentence you may show.

| Code | Means |
| --- | --- |
| `invalid-params` | The parameters are not a JSON object, or one of them breaks its rule. The message names it |
| `too-large` | The parameters take more than 256 KiB |
| `unknown-method` | Nendo does not answer that method |
| `busy` | 64 requests already wait, a second toast came within a second, or Nendo is finishing another action |
| `not-allowed` | A record page has unsaved changes, so Nendo stays where it is |
| `not-found` | The record type or the screen is not in this file |
| `views-off` | Custom views were turned off |
| `read-only` | The file is open read-only, so nothing may change it |
| `record-version-conflict` | The record changed since you read it. Read it again |
| `proposal-waiting` | A proposal your package prepared still waits for the person |
| `proposal-not-found` | Your package did not prepare that proposal in this session |
| `disconnected` | Nendo reconnected the view while the request waited. Send it again |
| `not-framed` | The page was opened on its own, not in Nendo |
| `stale-cursor`, `invalid-cursor` | The file changed between pages, or the cursor belongs to another query. Read again from the first page |

A read Nendo refuses keeps Nendo's own code, such as `validation`. At most eight
requests are in flight at once; the API holds the rest back, so a view that fires a
thousand reads is slowed rather than refused.

## Put the package in a file

The file carries the code. There are three ways to put it there, and each is a
proposal that a person reviews line by line before accepting. Nothing runs until the
proposal is accepted. Each way proposes only what differs from the package the file
already carries, and names the content each change replaces, so a proposal prepared
against an older package is refused rather than replayed over a newer one.

### From Studio

1. Open **Studio → Surfaces → Custom views**, or **File → Custom views…**.
2. Choose **Import package…**, and pick the folder's `nendo-package.json`, a `.zip`
   of the folder, or a `.nendoview` archive from before 2026-09-25.
3. Nendo reads the whole package, prepares the proposal and opens the review. Its
   **Code** section shows each file: the changed lines of a text file, and the sizes
   of any other. The review also says, once, that the code runs when a view that
   uses its package is shown.
4. Accept. A view that names the package now runs it.

A placeholder whose package is missing offers the same Import as **Add package to
file…**. Import is refused with `extension-unchanged` when the file already carries
the package exactly. **Export…** in the same panel writes a package back to a new
folder, with its `nendo-package.json`, so it can be edited and imported again.

### Over MCP

An agent at the **Shape app** access level writes the package through an ordinary
change set: take a lease, `nendo.change_set.begin`, add the operations with
`nendo.change_set.add_operations`, and `nendo.change_set.validate`. The person
accepts the proposal in Nendo. One mutation that holds the package and its files
becomes one revision, which History can compensate as a whole.

```json
{
  "description": "Put the Record list view in the file",
  "operations": [
    { "operationType": "extension.setPackage",
      "payload": { "packageId": "org.example.record-list", "title": "Record list", "version": "0.1.0" } },
    { "operationType": "extension.putFile",
      "payload": { "packageId": "org.example.record-list", "path": "index.html", "text": "<!doctype html>\n…" } },
    { "operationType": "extension.putFile",
      "payload": { "packageId": "org.example.record-list", "path": "view.js", "text": "(async () => {\n…" } }
  ]
}
```

- `text` is stored as UTF-8 exactly as written, and `base64` carries any bytes.
  `mediaType` is optional and defaults from the extension.
- One `putFile` payload is at most 96 KiB. Send a larger file in parts: a first
  `putFile`, then `putFile` operations with `append: true` for the same package and
  path, later in the same change set. Nendo joins the parts in order at validation.
  About two parts fit in one call.
- `expectedSha256` makes a put or a removal conditional: the hash the path holds
  now, or `absent` for a path that must be new.
- `extension.removeFile` removes a file, and `extension.removePackage` an empty
  package. A replaced or removed file stays in history.
- The preview's `packageChanges` lists each file as added, replaced or removed,
  with the changed lines of a text file: the same lines the person reads.

Read a package back at `nendo://application/extensions`, which lists each file's
path, media type, SHA-256 and size, and at
`nendo://application/extension/{packageId}/file?path=…&offset=…`, which returns a
file in pages of at most 131,072 bytes. Percent-encode the path, so
`tiles/world.bin` is `tiles%2Fworld.bin`, and follow `nextOffset` until it is null.
The example `put-a-custom-view-in-the-file` in `nendo://application/examples` is a
complete change set to copy.

### With `tools/Put-NendoPackage.mjs`

From a clone of this repository, with Nendo running, the file open and agent access
at **Shape app**:

```powershell
node tools/Put-NendoPackage.mjs extensions/gantt             # propose the folder
node tools/Put-NendoPackage.mjs extensions/gantt --dry-run   # say what it would send
```

The script reads `nendo-package.json` and every other file in the folder, except
paths with a segment that starts with `.` or is `node_modules`. It finds the
running Nendo through the files a running Nendo writes under
`%LOCALAPPDATA%\Nendo\Mcp\active`, and proposes only the files that differ. It
prints the proposal's title; accept it in Nendo. It never accepts anything.

With more than one Nendo running, name the file by its application ID with
`--application <applicationId>`. `--title` sets the proposal's title. The script
sends each operation as its own mutation, so History shows a revision for each
file. If the draft does not validate, the script prints why and leaves the draft
open.

## Show it: the view definition

A package runs only where a view definition names it. A definition is a node in the
file's screens, authored with `ui.addNode` in a change set that a person accepts,
like any other screen. The example `show-a-custom-graph` in
`nendo://application/examples` defines a graph.

A person can add one without an agent. In **Studio → Surfaces → Custom views**, each
package's card lists the screens and record pages that already show it, and has an
**Add view…** button. The form asks for the kind, a title, the record type (or, for a
panel, the record page) and the label and status fields, and for a graph the link record
type and its two ends. It offers only choices that pass the checks below, so a graph is
refused with a sentence rather than offered when no record type links the records.
**Preview view** prepares the same `ui.addNode` and `ui.setProperty` operations an
agent's inline node expands to, and opens the ordinary review. After you accept a screen,
Use opens on it. The form writes no pins and an empty configuration, so the view takes
the open rules and the file asks for host 1.34.0. Children (`fieldBinding`,
`filterClause`) and a configuration are still an agent's to write.

### A screen of records

An `extensionRecordsSurface` is a screen of one record type, and the view fills
it. In Use it is one of that record type's screens, listed by its title.

```json
{
  "description": "Show the tasks in the Record list view",
  "operations": [
    { "operationType": "ui.addNode",
      "payload": { "surfaceId": "taskRecordList", "nodeId": "taskRecordList", "parentNodeId": null,
        "kind": "extensionRecordsSurface", "position": 0,
        "properties": { "definitionVersion": 3, "entityId": "task", "title": "Record list",
          "packageId": "org.example.record-list", "labelFieldId": "taskTitle" } } },
    { "operationType": "ui.addNode",
      "payload": { "surfaceId": "taskRecordList", "nodeId": "taskRecordList.starts", "parentNodeId": "taskRecordList",
        "kind": "fieldBinding", "position": 0, "properties": { "fieldId": "taskStarts" } } }
  ]
}
```

### A graph

An `extensionGraphSurface` is a screen whose records are nodes and whose links are
records of another type. It also names `edgeEntityId`, the link type, and
`sourceFieldId` and `targetFieldId`, two distinct Reference fields of the link type
that both point at the node type. A `fieldBinding` under it may name a field of
either type.

### A panel on a record page

An `extensionRecordPanel` sits on a record page or a record form, at the place it is
authored: directly under the `detailSurface` or `recordForm`, or inside a
`section`, in a tab or not. It is about that page's record. It names no `entityId`,
because its record type is the page's, and it takes no link type and no filter. A
page may carry as many as it likes.

```json
{ "operationType": "ui.addNode",
  "payload": { "surfaceId": "taskPage", "nodeId": "taskPage.timeline", "parentNodeId": "taskPage",
    "kind": "extensionRecordPanel", "position": 4,
    "properties": { "title": "Timeline", "packageId": "org.nendo.gantt", "labelFieldId": "taskTitle" } } }
```

Here `taskPage` is the record page's root node. Its `fieldBinding` children name the
fields the view shows, and they are the view's: they never become fields of the
form around it.

### Properties

| Property | Graph | Records | Panel | Rule |
| --- | --- | --- | --- | --- |
| `definitionVersion` | Required | Required | — | `3` |
| `entityId` | Required | Required | — | The record type the view is about |
| `title` | Required | Required | Required | The view's title |
| `packageId` | Required | Required | Required | The package in this file that the view runs |
| `labelFieldId` | Required | Required | Required | Any active field of the record type, stored or calculated |
| `statusFieldId` | Optional | Optional | Optional | Any active field of the record type, stored or calculated |
| `configuration` | Optional | Optional | Optional | JSON text holding an object, at most 16 KiB and 32 levels deep |
| `edgeEntityId`, `sourceFieldId`, `targetFieldId` | Required | — | — | The link type and its two References to the node type |

A view may carry `fieldBinding` children, which name further fields to show, stored
or calculated, and, on a screen, `filterClause` children, which narrow its records:
`{fieldId, operator, value}` with an optional `valueKind`. A filter names a stored
field, uses the operators `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull` and
`isNotNull`, and may compare against `today` or `now` through `valueKind`. A view
carries at most 64 children, and each field is shown once. `loadRecords` and
`loadGraph` apply the filters; a query reads at most eight of them.

Earlier hosts required `packageVersion`, `packageDigest`, `protocolVersion` and
`configurationVersion`. They are not needed. When present, they are kept and read by
nothing.

### Configuration

`configuration` is for a view's settings: which field is the start date, a default
zoom, a colour scale. The view reads it parsed:

```json
"configuration": "{\"startField\":\"taskStarts\",\"zoom\":2}"
```

```js
const { startField = null, zoom = 1 } = nendo.context.configuration;
```

Nendo does not interpret it. It is not the place for data.

### What Nendo checks

- An invalid definition is the error `NUI450`, and the change set does not
  validate. The message names what is wrong: a package ID, a record type, a label, a
  field or a filter that does not exist or breaks a rule.
- A package the file does not carry is the warning `NUI452`. The definition is
  sound and waits for its code; the view says "‹package› is not in this file" where
  it is shown, and offers **Add package to file…**.
- A view that only the open rules accept needs host 1.34.0: no pins, a configuration
  with anything in it, a calculated label or field, a `today` or `now` filter, or
  more fields or panels than earlier hosts allowed. A view that the earlier rules
  accept keeps its earlier rung, 1.29.0 to 1.32.0. The review shows a raise before
  you accept it. A file that carries a package needs 1.33.0 in any case.

## Running, stopping and debugging

- **Develop from a folder.** Import the package once. Then, in Studio → Surfaces →
  Custom views, press **Develop from folder…** on its card and pick the package's
  folder. Every view of the package now runs from that folder on this computer, under
  a Development strip, and reloads whenever you save a file there. Nothing reaches the
  `.nendo` file: anyone else, and a copy of the file, runs the code the file carries.
  **Save to file…** prepares the proposal Import would, for you to review and accept;
  **Stop developing** puts the file's code back. A folder that stops reading as a
  package, say with a broken `nendo-package.json`, shows the reason in the view.

- A view starts when its place comes into view: a screen when you show it, a panel
  when the record page scrolls it near the window. Nothing runs in Studio, in safe
  mode or during recovery.
- **DevTools.** Right-click inside the running view and choose **Inspect**. DevTools
  open on the element you clicked. To run code inside the view, choose its frame as
  the Console's context, in the drop-down that starts at `top`. The Network and
  Application panels show its requests and its storage, and its `console.log` lines
  appear in the Console.
- **Not responding.** Nendo pings each view every five seconds, and the API answers
  for you. A view that keeps its main thread busy for ten seconds is marked "This
  view is not responding", with **Stop** and **Reload**. Stop ends every view of the
  same package, because they share one renderer process. Keep long work in a worker
  or in slices.
- **A crash.** If a view's renderer ends, each of its package's views says "This
  view stopped", with **Reload**. The rest of Nendo is unaffected.
- **Switches.** **Run custom views** turns every view off on this device, and **Run
  this file's views** turns off this file's. Both are in Studio → Surfaces → Custom
  views. If a view brings the whole window down, the recovery panel offers **Restart
  without custom views**, which keeps views off until you turn them on again or
  start Nendo again.
- **Test outside Nendo.** The four packages are measured in Playwright by their
  `Review-*.ps1` lanes, which serve the package on one origin and a fixture broker,
  `tools/Graph-FixtureBroker.html`, on another, with the real `api.js` between them.
  Copy one of those lanes for your own package.

## What a view can and cannot reach

| A view can | A view cannot |
| --- | --- |
| Read every record type in its file, calculated fields and exact numbers included | Reach Nendo's own page: `parent.document` throws |
| Hear every change to its file | Reach the host bridge: `window.chrome.webview` answers nothing in a frame |
| Use the network, loopback included, and open WebSockets | Use Nendo's MCP endpoint, which refuses browser origins |
| Read and write the clipboard, and download files | Reach SQL, a file path, another file or a device setting |
| Keep `localStorage` and IndexedDB, per package and file, on this device | Navigate Nendo away, or load Nendo inside a frame |
| Send a link the person clicks, one that opens a new window, to their own browser | Open a window by script without the person's click |
| Show the browser's `alert`, `confirm` and `prompt` | Prepare a proposal or keep state in the file (not yet) |
| Create, change and delete records and run record commands, in its package's name | Write under any other name, or without a version check |
| Ask Nendo to open a record, a screen or Studio, show a sentence and size its panel | Accept or reject a proposal, ever |

Browser storage belongs to the view's origin, which is its own for each package in
each file. It stays on this device and does not travel with the file.

A received file's code runs when its view is shown, with these powers. The switches
are the control. The [contract](contracts/custom-views.md#the-trade) states the
trade.
