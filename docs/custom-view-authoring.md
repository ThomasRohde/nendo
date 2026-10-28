# Authoring a custom view

This guide tells how to write a Nendo custom view, put it in a `.nendo` file and show
it. The [custom-view contract](contracts/custom-views.md) states every rule this guide
depends on; where they disagree, the code is current, so fix the contract and this guide
to match it. The authority is
[ADR-0013](decisions/0013-custom-views-with-code-in-the-file.md).

A custom view is a small web page that draws a file's records in a way Nendo's own
screens cannot: a graph, a Gantt chart, a map. Its code lives in the `.nendo` file as a
**package**. A view that is shown runs, inline in Nendo, in a frame of its own. There is
nothing to install and nothing to allow.

Worked examples, one folder each under `extensions/`, each with a README. Two are here:
[`systems-lens`](../extensions/systems-lens/README.md) (the Nendo Station schematic) and
[`swarm`](../extensions/swarm/README.md) (a behaviour playground). The rest are in
[`nendo-apps`](https://github.com/ThomasRohde/nendo-apps), a repository beside this one
([ADR-0040](decisions/0040-apps-live-in-their-own-repository.md)): `dependency-graph` (a
general record graph), `work-dependencies` (the planner's dependency view), `gantt` (a time
line, also on a record page), `bcm-atlas` (a capability map over any record type kept as a
tree, configured by its view's configuration), `garden` (a notes workspace), `archi` (an
ArchiMate modeller), `deck` and `brandkits` (slide decks and the brand kits they use),
`manuscript` (a manuscript editor) and `clay` (a collect-anything app that grows its own
shape). Third-party code sits in a package's `vendor/` with its licence beside it. The
Swarm's bpmn-js is under the bpmn.io licence, which requires its watermark to stay
visible.

## What a view can do

A view is a web page with most of a web page's powers: the network, loopback included,
the clipboard, browser storage, workers, WebAssembly, fonts, images and any other file
it carries. It reads the file through `window.nendo`: records with their calculated
fields and exact numbers, the schema, and the file's changes as they happen. It can ask
Nendo to open a record, a screen or Studio, show a sentence, and size its own panel. It
writes records and runs record commands ([Changing records](#changing-records)),
proposes changes to the app ([Proposing a change](#proposing-a-change)) and keeps small
values with the file ([Keeping state](#keeping-state)). Its controls can be Nendo's own
([Controls in Nendo's toolbar](#controls-in-nendos-toolbar)).

A view is a screen of one record type, a panel on a record page, or, as an
`extensionView` root, a screen of the file itself beside the front page (host 1.42.0),
which the file may open on. A tile on the front page is not built.

A view can never reach the Workbench's own page, the host bridge, SQL, a file path,
another file or a device setting, and it can never accept a proposal. See
[What a view can and cannot reach](#what-a-view-can-and-cannot-reach).

## A first view

A package is a folder. This one lists the records its view is about, and opens one when
you select it. It has four files.

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
  // The page's own words are English, so <html lang="en"> stays: a screen reader reads them in
  // an English voice. context.locale is the person's language, for formatting dates and numbers
  // (toLocaleDateString(context.locale, …)), never the language of the view's text.

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
trailing commas are allowed, and other keys are ignored. The file never stores the
manifest as a file: the package row holds what it says, and export writes it again.

| Key | Rule |
| --- | --- |
| `packageId` | Required. 3–80 characters, lowercase, at least two dotted segments, each starting with a letter and holding only letters, digits and `-`, such as `org.example.map`. It is the package's stable name |
| `title` | 1–200 characters. Default: the package ID |
| `version` | Optional. A semantic version such as `1.0.0`, at most 40 characters |
| `entryPoint` | Default: `index.html`. It must be one of the package's files |
| `description` | Optional. At most 1,000 characters |
| `settings` | Optional. The settings the person changes on Nendo's Settings page ([Settings](#settings)) |

### Files

Every other file in the folder is part of the package, of any type. Hidden and system
files, links, and any path with a segment that starts with `.` or is `node_modules` are
left out, so `.git` and `node_modules` stay behind. No build step is needed, and a
bundler's output folder works as well.

- A path uses letters, digits, `_ - . ~` and `/`, at most 240 characters. It cannot
  start with `_nendo/`, which is reserved on every view's origin. Two paths may not
  differ only in case.
- A file holds at most 4 MiB, a package 512 files and 16 MiB, and a `.nendo` file 64
  packages and 64 MiB of package bytes. One change set brings at most 4 MiB of new
  content.
- The media type comes from the extension, and an unknown extension is
  `application/octet-stream`. Nendo serves every file with `X-Content-Type-Options:
  nosniff`, so the browser runs a script only when its type is JavaScript: give scripts
  a `.js` or `.mjs` extension. A `.ts` file is `text/plain` and does not run.

## The API: `window.nendo`

### Load it

Put `<script src="/_nendo/api.js"></script>` before your own scripts. Every view origin
serves it from the installed Nendo, not from your package, so a view always talks to
the Nendo it runs in. It defines `window.nendo` and nothing else, and connects to the
Workbench over a private `MessageChannel`
([the handshake](contracts/custom-views.md#the-view-api)); a view never speaks it
itself.

### Wait for `nendo.ready`

`await nendo.ready` resolves with the view's **context** once the Workbench has
connected the frame. A page opened on its own, outside any frame, is told so:
`nendo.ready` rejects with `not-framed`, and so does every call. `nendo.context` always
holds the latest context.

| Key | Holds |
| --- | --- |
| `viewId` | The view's node ID in the file |
| `kind` | `extensionGraphSurface`, `extensionRecordsSurface`, `extensionView` or `extensionRecordPanel` |
| `placement` | `screen`, or `recordPage` for a panel on a record page |
| `title`, `packageId` | The view's title, and the package it runs |
| `entityId` | The record type the view is about |
| `recordId` | On a record page, that page's record; otherwise null |
| `bindings` | `labelFieldId`, `statusFieldId`, `edgeEntityId`, `sourceFieldId`, `targetFieldId`; `fields`, each `{fieldId, entityId}`; `filters`, each `{fieldId, entityId, operator, value, valueKind, storageKind}` |
| `configuration` | The definition's configuration, parsed. `{}` when there is none |
| `theme` | `{mode, tokens}`, the person's theme |
| `locale` | The browser's language |
| `readOnly` | True when the open file does not accept edits |
| `place` | Where Back or Forward put the view, or null ([Back and Forward](#back-and-forward)) |
| `methods`, `apiVersion` | Every method the Workbench answers, and `1` |

The bindings are not permissions: a view can read any record type in the file.
`nendo.has(name)` says whether the Workbench answers a method, so a view can use a
method added later where it exists.

## Reading records

### The view's own records

- `nendo.view.loadRecords()` reads the records the view is about: its record type under
  its definition's filters, with `today` and `now` resolved as it reads, up to 10,000
  records. On a record page it reads that page's one record.
- `nendo.view.loadGraph()` reads a graph view's records as nodes and its link records
  as edges, as `{nodes, edges, fields, hiddenEdges}`. A node is `{id, label, status,
  values, record}`, with `label` as text; an edge is `{id, source, target, values,
  record}`. An edge whose source or target is not among the nodes is left out and
  counted in `hiddenEdges`: say so, rather than draw a graph that looks complete.

### Any records

The `nendo.records` calls read any record type in the file, through the same bounded
reads the Workbench uses:

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

- A filter is `{fieldId, operator, value}`. The operators are `eq`, `ne`, `lt`, `le`,
  `gt`, `ge`, `contains`, `isNull` and `isNotNull`; the last two take no value. On a
  record type that declares a hierarchy, `descendantOf` on its parent field takes a
  record ID and matches everything under it. A query carries at most eight filters. A
  choice compares by its option ID. A query may sort by a calculated field and filter
  on one: Nendo works the values out for every record the stored filters leave, at most
  10,000, and refuses a wider read with `calculated-query-too-wide`.
- `records.groupAggregate`, `records.bucketAggregate` and `records.cellAggregate`
  answer the grouped, date-bucketed and crossed totals Nendo's own charts draw.
  `aggregate` is `count`, `sum`, `min` or `max`; `avg` is refused. The vocabulary,
  `nendo://application/vocabulary`, publishes the `bucket` and `range` words.
- `records.tree({entityId, rootRecordId, depth})` reads a declared hierarchy
  depth-first, siblings in order, as `{record, parentRecordId, depth, childCount}`.
  Without `rootRecordId` it starts at the top level; `depth` is 1 to 32, default 1.
  `records.treeAll(query, {max})` reads every page.
- `records.queryAll(query, {max})` follows the cursor, 200 records at a time, up to
  `max` (10,000 by default). If the file changes between pages, it reads again from the
  top, at most three times.
- `records.search(text, {entityIds, fieldIds, limit, cursor})` finds records by any
  word in their text fields, best match first
  ([ADR-0028](decisions/0028-full-text-search-in-the-file.md)). Every word is required;
  quoted text is a phrase, `-word` leaves records out, and the last word also matches as
  a prefix. Each hit is `{entityId, recordId, version, label, score, fields}`, each field
  `{fieldId, snippet, ranges}`. A file without a search index, which the person builds
  once in Studio or Ctrl K, refuses it with `search-index-missing`.

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

`nendo.schema.describe()` answers the file's `purpose`, its `changeSequence`, each
record type with its fields, `hierarchy` and `linkRule`, and its screens and commands.
A field carries its `displayName`, `storageKind`, `required`, `calculated`, a
calculated field's `expression`, a choice field's `choices` (`{id, displayName,
retired, tone}`), a reference's target and a rating's scale. Retired record types and
fields are left out. The [contract](contracts/custom-views.md#records-and-the-schema)
has the whole shape.

## Following the file

`nendo.on(name, listener)` subscribes to one of seven events and returns a function
that unsubscribes. Any other name is refused with `unknown-event`:

| Event | Data | When |
| --- | --- | --- |
| `changes` | The file's change sequence | When anything commits to the open file, from anyone: at most once every 250 ms, carrying the latest sequence |
| `context` | The context | When the view's context changes, for example after its definition changed, and once when the person's day turns |
| `theme` | `{mode, tokens}` | When the person switches between light and dark |
| `place` | The place the view declared with `ui.setPlace`, or null | When Back or Forward moved the person to one of the view's places ([Back and Forward](#back-and-forward)) |
| `command` | `{id, value, source}` | When the person pressed one of the controls the view declared ([Controls in Nendo's toolbar](#controls-in-nendos-toolbar)) |
| `assistant` | `{state, name, working, access}` | When the person's launched agent starts, signs in, begins or ends a turn or ends, or the person changes what views may do ([Asking the person's agent](#asking-the-persons-agent)) |
| `settingsChanged` | `{id: value}` for every setting your package declares | When one of them changes, on Nendo's Settings page, in the file or on this computer. `nendo.settings.all()` reads them; declare them under `settings` in `nendo-package.json` |

An event is a nudge, not data. Read again what your view shows, and collapse a burst
into one read, as the first view does. `nendo.changes.subscribe(listener)` is the same
as `nendo.on('changes', listener)`.

When an accepted proposal changes the view's package, Nendo starts the view again on
the new code. A redraw of the page around a view does not reload it.

## Colours and the theme

The API sets the Workbench's colours on your document's root as custom properties,
`--nendo-‹token›`, and keeps them current: the surfaces, ink, lines, accents, status
colours and the eight choice tones `--nendo-tone-red` to `--nendo-tone-grey` (the
[contract](contracts/custom-views.md#events) lists every token). It also sets
`data-nendo-theme` on the root to `light` or `dark`, and adds a `color-scheme` meta
element after any of yours.

A view that draws with these follows the person's theme without listening for it. Give
each token a fallback, as `view.css` does. A choice's `tone` names one of the eight
tones, so a status drawn in `--nendo-tone-‹tone›` reads as it does elsewhere in Nendo.
Do not use `prefers-color-scheme`: it follows Windows, and a person can choose Light or
Dark in Nendo against it. `nendo.ui.theme` and the `theme` event carry the same values
for a canvas or a chart library.

## What a view owes the person

A view draws its own document, so Nendo's focus rings, keyboard traversal and text
alternatives stop at its frame. The view kit carries them across. It is one versioned
file, `tools/view-kit/nendo-view-kit.js` (1.1.0), that a package copies to
`kit/nendo-view-kit.js` and imports as a module, even from a classic script:

```js
const kit = await import('./kit/nendo-view-kit.js');
kit.installFocusRing(document);                    // a ring in --nendo-cobalt; Highlight in forced colours; less motion when asked
const keys = kit.roving(rows, { items: '.row', orientation: 'vertical' });
// after each redraw that replaces the rows:
keys.refresh();
```

- `roving` makes a list, a grid or a graph one tab stop. Up and Down (or Left and Right,
  or all four with `orientation: 'spatial'`, to the nearest item in that direction),
  Home and End move within it; Enter and Space activate. The stop is remembered by the
  item's `data-id`, or by `key: item => …`, so `refresh()` after a redraw keeps it on
  the same record; an item without a key falls back to the first item. `refresh()` does
  not move focus: a redraw that removed the focused item focuses its replacement itself,
  with `{ preventScroll: true }`.
- `textAlternative(container, { label, items })` writes a list, hidden from the eye,
  that a screen reader reads for a drawing it cannot.
- `fitBox(content, viewport, padding)` gives the scale and offset that fit a drawing,
  centred. A drawing flat in one direction is fitted by the other, and a single point is
  drawn at scale 1 in the middle. In a frame not sized yet the scale stays 1 and the
  drawing starts at the padding, and the scale is always above zero.
- `toneFor(value, choices)` gives a status value's tone.

`tools/view-kit/kit.test.mjs` checks every `extensions/*/kit/nendo-view-kit.js` against
the source byte for byte.

Text scale, reduced motion and high contrast reach a view's frame through the standard
media queries (`prefers-reduced-motion`, `forced-colors`, `prefers-contrast`) and the
page's own zoom, not the theme. The kit's focus ring answers the first two.

## Acting for the person

- `nendo.ui.openRecord(entityId, recordId)` opens a record. On a Use screen of that
  record type, it opens beside the view, which keeps running. A type Use does not show
  opens in Studio's Data view.
- `nendo.ui.openScreen(surfaceId)` shows a screen in Use, by its root node ID as
  `schema.describe` lists it, or by its surface. The front page is a screen too.
- `nendo.ui.openStudio(entityId)` opens Studio's Data, on one record type when named.
- Made on its own, with the person not in the view, the three moves together go at most
  once a second; the next is refused as `busy`. A move the person makes by clicking in
  your view is not bounded. A view that is not on screen, such as one waiting while the
  person reviews its proposal, is refused `not-allowed`. Move the page when the person
  asks, not on a timer.
- `nendo.ui.toast(text)` shows "‹view title›: ‹text›" over the bottom right of Nendo's
  window for a few seconds: 1–300 characters, at most one a second.
- `nendo.ui.setHeight(pixels)` sets a record-page panel's height, 80 to 4,000 pixels; a
  panel starts at 360. A view on a screen fills it, and `setHeight` answers the height
  it has.

Navigation follows the rules a click follows: while another action runs, or a record
page holds unsaved typing, it is refused and nothing moves.

To fit a panel to its content, measure the content, not the document, which is always
at least as tall as the frame:

```js
if (context.placement === 'recordPage') {
  const content = document.getElementById('content');
  new ResizeObserver(() => {
    nendo.ui.setHeight(Math.ceil(content.getBoundingClientRect().height) + 32).catch(() => {});
  }).observe(content);
}
```

### Back and Forward

A view with pages of its own tells Nendo where it is, so Back and Forward go through
those pages, and Back from a record the view opened returns to the page it was on:

```js
nendo.ready.then((context) => {
  show(context.place ?? { page: 'start' });          // where Back or a return put this view
  nendo.on('place', (place) => show(place ?? { page: 'start' }));
});

function open(page) {
  show({ page });
  nendo.ui.setPlace({ page }, { label: titleOf(page) });  // a step, named on Nendo's Back button
}

function select(id) {
  nendo.ui.setPlace({ page: current, selected: id }, { label: titleOf(current), replace: true });
}
```

A place is plain JSON of at most 4 KiB. `replace: true` corrects the step the person is
on, for a selection and for the place a view starts at; without it the place is a new
step. Declaring the place the view already has does nothing. Answer the `place` event by
showing the place, never with a new step. While the view is not on screen a declaration
is refused `not-allowed`; declare again when it is shown. Ask `nendo.has('ui.setPlace')`
first.

## Asking the person's agent

When the person has an agent launched from the Agent page, or can launch one, a view can
send it a message and use the reply
([ADR-0033](decisions/0033-a-view-messages-the-launched-agent.md)):

```js
if (nendo.has('assistant.ask')) {
  const { reply, stopReason } = await nendo.assistant.ask('Summarise the notes tagged draft.', {
    context: [{ uri: 'nendo://application/manifest', title: 'This file' }],
  });
}
```

- `ask` answers once the agent's turn ends: `reply` is the agent's message text of your
  turn only, and `stopReason` is `end_turn`, `cancelled`, `max_tokens`,
  `max_turn_requests`, `refusal`, `error`, or `ended` when the conversation ended first.
- The agent runs one turn at a time. A message sent while it works waits, in order, and is
  sent when the turn before it ends; at most 8 wait, 2 of them yours.
- Nendo asks the person first, in its own card: to launch the agent when none runs, and,
  unless they chose Always, whether your view may message it, once per conversation.
- Your message shows in the conversation with your view's title. The agent's permission
  requests go to the person, never to you.
- The agent reaches the file over MCP at the person's access level. Results that matter
  should be records it writes, which you hear as `changes`; the reply is text.
- `nendo.assistant.status()` and the event `assistant` say `{state, name, working,
  access}`. The agent's model, effort and mode are the person's, set on the Agent page.
- `nendo.assistant.cancel()` stops your own turn: dropped while it waits, stopped while it
  runs.

## Controls in Nendo's toolbar

A view draws its content, and Nendo draws its controls. Declare them, and Nendo draws
them with its own parts: on a screen in the Use toolbar before Nendo's Add, in the
address row where the window has room or the row under it; on a record page in your
panel's header. They are listed in Ctrl K under your view's title, with their keys, and
shown with the shortcut hints. Each press comes back as the event `command`.

Where Nendo draws your controls, draw none of your own, and no page title: Nendo's
breadcrumb names the page. A line that sums up what the view shows goes in the row as a
`text` item, which is cut short, with its whole text as a tooltip, before it pushes a
control off the line. An explanation of how to read the view goes behind a toggle (the
`info` icon), shown over the view when pressed. Keep a problem, such as a refused read,
in your frame, where it can be read whole.

```js
function declare() {
  nendo.ui.setToolbar({
    items: [
      { kind: 'choice', id: 'mode', label: 'Mode', hideLabel: true, value: mode,
        options: [{ value: 'map', label: 'Map' }, { value: 'list', label: 'List' }] },
      { kind: 'select', id: 'colour', label: 'Colour', value: colour, options: colourOptions },
      { kind: 'spacer' },
      { kind: 'search', id: 'find', label: 'Find a task', placeholder: 'Find…', keys: 'Ctrl+F' },
      { kind: 'toggle', id: 'pan', label: 'Pan', icon: 'pan', iconOnly: true, pressed: panning },
      { kind: 'group', label: 'Zoom', items: [
        { kind: 'button', id: 'zoom-out', label: 'Zoom out', icon: 'minus', iconOnly: true, keys: 'Ctrl+-' },
        { kind: 'button', id: 'fit', label: 'Fit', keys: 'Ctrl+0' },
        { kind: 'button', id: 'zoom-in', label: 'Zoom in', icon: 'plus', iconOnly: true, keys: 'Ctrl+Plus' },
      ] },
      { kind: 'menu', id: 'export', label: 'Export', icon: 'export', items: [
        { id: 'export-svg', label: 'SVG', detail: 'Shapes and text to edit' },
        { kind: 'check', id: 'light', label: 'Light colours', checked: light },
      ] },
    ],
    add: 'new-task',   // Nendo's own Add button runs this command on your screen
  });
}

nendo.on('command', ({ id, value, source }) => {
  // value: a toggle's or a check's new state, the option chosen, the text searched for,
  // or a radio item's value; null for a button or a menu item.
});

if (nendo.has('ui.setToolbar')) declare(); else showOwnToolbar();
```

- **The kinds** are `button`, `toggle` (with `pressed`), `choice` (a segmented
  control), `select`, `search`, `menu`, `group`, `text`, `separator` and `spacer`. A
  menu holds `item`, `check`, `radio`, `label` and `separator` entries. A group holds
  buttons and toggles, drawn as one control.
- **Words are text.** A label, an option or a detail line is drawn as text, never as
  markup. The icons are Nendo's own, by name: plus, minus, search, fit, pan, export,
  filter, list, link, focus, more, check, edit, external, trash, arrowUp, arrowDown,
  chevronLeft, chevronRight, indent, outdent, layers, chain, refresh, settings, eye,
  command, info, clipboard, layout, undo, redo, widthNarrow, widthMedium and widthFull.
  An older Nendo refuses an icon it has not got, so a view that wants to run there
  declares again without it.
- **Declare again when your state changes.** Each call replaces the last, and `[]`
  removes the toolbar. Nendo shows a press at once, and your next declaration decides
  what stands. The API sends the latest declaration at most once every 100 ms.
- **Search** sends the text as the person types, after a short rest. Enter sends it at
  once, so an Enter always leaves your view hearing the same text twice in a row: take
  that as a request for the first match.
- **Keys** need Ctrl or Alt, except F2 to F12: `Ctrl+Shift+F`, `Alt+ArrowUp`,
  `Ctrl+Plus`. Nendo's own keys are refused: Ctrl K, Ctrl 1 to 7, F1, Ctrl B, Alt F,
  Ctrl /, Alt ← or →, Ctrl T, Ctrl W and Ctrl Tab. They work while your view has focus.
  A declared key pressed in your view goes to Nendo unless you handle it yourself
  (`preventDefault`) or the person is typing in a field.
- **Add.** Name one of your commands in `add`, and Nendo's Add button on your screen
  runs it instead of opening Nendo's form.
- **Bounds.** At most 32 controls in the row, 8 in a group, 12 options in a choice, 64
  in a select, 48 items in a menu, 80 characters in a label, and 16 KiB in all. A
  declaration past a bound is refused whole, with `invalid-params` naming the rule, and
  Nendo keeps drawing the last one it accepted.
- **More.** Controls that do not fit the row go, from the end, into Nendo's More menu.

### A menu at the pointer

`nendo.ui.showMenu(items, at)` draws Nendo's menu at a point in your view. `at` is
`{x, y}` in your page's pixels, or the mouse event itself. The call answers `{id,
value}` for the item picked, or `null` when the person dismisses the menu. Call
`preventDefault()` on the `contextmenu` event, or the browser's own menu opens as well.
A key shown on a menu item is only shown: handle it in your view. One menu is open at a
time, at most four a second.

```js
map.addEventListener('contextmenu', async event => {
  const card = event.target.closest('.card');
  if (!card || !nendo.has('ui.showMenu')) return;
  event.preventDefault();
  const pick = await nendo.ui.showMenu([
    { id: 'open', label: 'Open record', icon: 'external' },
    { id: 'rename', label: 'Rename', keys: 'F2' },
    { kind: 'separator' },
    { id: 'delete', label: 'Delete…', icon: 'trash', danger: true },
  ], event);
  if (pick?.id === 'open') nendo.ui.openRecord(entityId, card.dataset.id);
});
```

A command from Nendo's row reaches a view without focus, where the browser refuses a
clipboard write: call `window.focus()` before writing the clipboard from a command.

## Changing records

A view changes records the way a person's edit does: through the same typed operations,
checked against the record's version, and recorded in History under your package's
name, `extension:‹package›`, where the person can undo it. Nendo draws no confirmation;
if an act needs one, ask the person yourself.

```js
const task = await nendo.records.get('tasks', 't1');
const updated = await nendo.records.update(task, { title: 'Pour the base', estimate: 12.5 });
const done = await nendo.commands.run('page.done', updated);   // a command from schema.describe
const added = await nendo.records.create('tasks', { title: 'Cure the slab' });
await nendo.records.delete(added);
```

- Each call takes the record as you last read it, `{entityId, recordId, version}`, and
  answers the record as it now stands, with its new version. Keep that one for the next
  write. `delete` answers null.
- If somebody changed the record since you read it, the write is refused and nothing
  changes. Read it again and decide.
- A value is null, text, true or false, a number, or `{ $nendoNumber: '12.50' }` for a
  decimal whose digits a JavaScript number would not keep.
- A file open read-only refuses every write with `read-only`.
- A write that points a reference at a record passes that record's version, as you read
  it, in `targetVersions`: `create('tasks', { owner: person.recordId }, {
  targetVersions: { owner: person.version } })`, or `update(task, values, {
  targetVersions })`. Without one it is refused (`target-version-required`), and so is
  one whose target changed since. Clearing a reference needs none. `create`'s third
  argument may also be the record ID alone.
- `records.move` moves a record in a declared tree, under a parent or to the top level,
  before a sibling or last.

**Several writes at once.** A gesture that changes many records goes in one
`records.batch`. Every write commits or none does, and History shows one entry under
your label:

```js
const { records, revision } = await nendo.records.batch([
  { op: 'create', entityId: 'boxes', recordId: 'b9', values: { name: 'New', x: 40, y: 40 } },
  { op: 'update', entityId: 'boxes', recordId: 'b1', version: 3, values: { x: 120, y: 80 } },
  { op: 'update', entityId: 'links', recordId: 'l4', version: 1, values: { target: 'b9' } },
  { op: 'delete', entityId: 'boxes', recordId: 'b2', version: 5 },
], { label: 'Arrange' });
// records: [{entityId, recordId, version}, …] in the same order; version null for b2
```

- Up to 200 writes. A record appears once: put its changes in one `update`.
- `l4` points at `b9`, which the batch creates, without a target version: a reference to
  a record written earlier in the batch is checked against the version that write
  leaves.
- A batch has no move. Set a tree's parent and order fields in an `update`, or use
  `records.move`.
- **Name a batch you may send again.** A write that ends in `disconnected` or
  `host-timeout` may have been kept. Give the batch a `writeKey`, 1 to 64 letters,
  digits, `-` or `_`: `nendo.records.batch(writes, { label: 'Arrange', writeKey:
  'arrange-7' })`. Sent again with the same writes under the same key, it answers as the
  first did if that was kept, and writes once if it was not; the same key with other
  writes is refused. A key is kept under your package's name, and a create that names no
  record ID gets the same ID each time. Without a `writeKey`, every call is a new write:
  read before you write again.
- `offerUndo: true` asks Nendo to offer Undo in its own notice, named by your label.

**Undo and redo.** Keep each batch's `revision` as a step. `records.undo(revision)`
takes the batch back as one new revision: fields put back, deleted records restored
under their own IDs, created records deleted. `records.redo` takes the undo's revision
and makes the batch again. Each answers like a batch:

```js
const undone = await nendo.records.undo(revision);         // History: "Undo Arrange"
const redone = await nendo.records.redo(undone.revision);   // History: "Redo Arrange"
```

- Only what this view wrote since it opened: anything else is `not-this-view`.
- If a record has been changed or deleted by somebody else since, or something now
  points at a record the undo would delete, the whole step is refused and nothing is
  written.
- Nendo keeps no stack for you. Keep your steps, their order and their names, and
  declare Ctrl+Z and Ctrl+Y with the `undo` and `redo` icons. Ask
  `nendo.has('records.undo')` first.

**Drafts.** Nendo ends a view's frame without asking when it leaves the screen. Keep
unsaved typing in your origin's browser storage, restore it when the view starts again,
and let the person discard it.

### Proposing a change

A view can ask for a change to the app itself, such as a field it needs or a new
screen, and the person decides. It sends canonical operations, the same ones an agent
sends (`nendo://application/vocabulary` lists them), and Nendo opens its ordinary
review at once, saying which view asked. Leave `expectedDefinitionRevision` out: Nendo
fills it in.

```js
const asked = await nendo.proposals.prepare('Add a due date', [{
  operationType: 'schema.addField',
  payload: { entityId: 'tasks', fieldId: 'due', displayName: 'Due', storageKind: 'date',
    required: false, presentation: 'date', options: [] },
}]);
// asked: { proposalId, title, state: 'previewable', diagnostics: [], opened: true }
const later = await nendo.proposals.get(asked.proposalId);   // 'active' once accepted
```

- Your view keeps running while the review is open. Follow the outcome with
  `proposals.get`, or listen to `changes`.
- A proposal the file cannot take comes back `invalid`, with `diagnostics` that say why.
- One proposal of your package waits at a time. Asking again is refused with
  `proposal-waiting`, naming it; `proposals.open(id)` opens it again.
- You cannot accept or reject. That is the person's.
- `opened` is false when Nendo could not open the review then; call `proposals.open`
  later.

### Settings

A choice the person makes about how your app behaves, such as a typeface, a text size or
which checks run, is a setting. Declare it under `settings` in `nendo-package.json`, and
Nendo draws it on its **Settings** page under your app, so it can be changed while your
views are off. A setting says where its value may be kept with `layers`: `personal` on
each computer, `shared` in the file for everyone who opens it, or `both`, where this
computer's value wins over the file's.

```json
"settings": [
  { "id": "size", "title": "Text size", "help": "How large the page draws its text.",
    "type": "choice", "default": "medium", "layers": "both",
    "options": [{ "value": "small", "label": "Small" }, { "value": "medium", "label": "Medium" },
                { "value": "large", "label": "Large" }] },
  { "id": "showCount", "title": "Show the count", "type": "toggle", "default": true, "layers": "personal" }
]
```

`type` is `toggle`, `choice`, `number` or `text`. A choice lists its `options`; a number
may have `min`, `max` and a `unit`; text may have a `maxLength`. The rules are under
[Settings a package declares](contracts/custom-views.md#settings-a-package-declares).

```js
let settings = await nendo.settings.all();      // { size: 'medium', showCount: true }
nendo.on('settingsChanged', values => { settings = values; draw(); });
await nendo.settings.set('size', 'large');      // this computer's value; null takes it away
```

- Each value is the one the person sees: the default, then the file's value, then this
  computer's. `nendo.settings.get(id)` reads one.
- `nendo.settings.set` keeps this computer's value at once, for a setting whose layers
  are `personal` or `both`, and every view of the package hears `settingsChanged`.
- A value in the file is a change to the app: prepare `package.setSetting` with
  `nendo.proposals.prepare`, and the person reviews it. An agent sends the same operation
  in a change set (example `give-an-app-settings`).
- Check `nendo.has('settings.all')` first, and draw with your defaults where it is missing.
- Keep a setting here, not in `nendo.state` or `localStorage`: those are for what the
  view remembers, such as a fold, a width or a draft.

### Keeping state

A view keeps small JSON values with the file: a layout, the open panel, a zoom level.
They travel with the file, unlike `localStorage`, which stays on one computer. A choice
the person would look for in Settings is a [setting](#settings) instead.

```js
const saved = await nendo.state.get('layout');          // { key, value, version } or null
await nendo.state.set('layout', { zoom: 2, pinned: ['t1'] });
await nendo.state.set('palette', 'warm', { scope: 'package' });   // shared by the package's views
const keys = await nendo.state.keys();                  // [{ key, version }]
await nendo.state.delete('layout');
```

- A value belongs to this view unless you pass `{ scope: 'package' }`.
- Values are JSON of at most 64 KiB, 256 keys per view and 1 MiB per package. An
  object's keys may come back in another order.
- Every change is in History under your package. Writes go at most twice a second:
  writing one key again before its write has gone replaces the value, and every call
  hears the one answer. Keep a scroll position in `localStorage`, not here.
- Pass `{ expectedVersion }` to refuse a write when somebody else changed the key since
  you read it (`state-version-conflict`); 0 means the key must not exist yet. Such a
  write is never joined with another.

## When a request is refused

A refused call rejects with a `nendo.NendoError`. Its `code` is stable, and its
`message` is a sentence you may show.

| Code | Means |
| --- | --- |
| `invalid-params` | The parameters are not a JSON object, or one of them breaks its rule. The message names it |
| `too-large` | The parameters take more than 256 KiB |
| `unknown-method` | Nendo does not answer that method |
| `busy` | 64 requests already wait, a second toast or a second move of the page came within a second, or Nendo is finishing another action |
| `not-allowed` | A record page has unsaved changes, so Nendo stays where it is; or the view is not on screen, so it cannot move the page or keep a place |
| `not-found` | The record type or the screen is not in this file |
| `views-off` | Custom views were turned off |
| `stale-file-session` | The person opened another file. Nendo disconnects the view and its frame ends; do not retry |
| `read-only` | The file is open read-only, so nothing may change it |
| `record-version-conflict` | The record changed since you read it. Read it again |
| `proposal-waiting` | A proposal your package prepared still waits for the person |
| `proposal-not-found` | Your package did not prepare that proposal in this session |
| `state-version-conflict` | The key changed since you read it, or it exists and you expected version 0 |
| `state-too-large` | The view has 256 keys, or the package 1 MiB of state |
| `record-referenced` | Other records still point at the record you are deleting |
| `target-version-required` | A reference was written without its target's version in `targetVersions` |
| `target-version-conflict` | A reference's target changed since you read it. Read it again |
| `actor-not-allowed` | The file no longer carries your view's package |
| `disconnected` | Nendo reconnected the view before it answered. A read can be sent again. A write may have been kept: read before writing again, or send a batch again under the same `writeKey` |
| `host-timeout` | Nendo did not answer in time. A write may have been kept, as with `disconnected` |
| `written-not-read` | The write was kept, but reading the record back failed. Do not write it again; read the record |
| `not-framed` | The page was opened on its own, not in Nendo |
| `unknown-event` | `nendo.on` was given a name that is not one of its seven events |
| `assistant-off` | The person chose Never for views on the Agent page. Do not ask again |
| `assistant-declined` | The person said Not now in Nendo's card. Nendo refuses your package without a card until the conversation changes |
| `assistant-unavailable` | No agent can run now: access is Off, the file is read-only, or none is installed. Nendo showed the person the way |
| `assistant-busy` | Too many messages already wait for the agent. Ask again when it has answered some |
| `stale-cursor`, `invalid-cursor` | The file changed between pages, or the cursor belongs to another query. Read again from the first page |
| `failed` | The answer could not be sent, or the failure had no code of its own |

A read Nendo refuses keeps Nendo's own code, such as `validation`. At most eight
requests are in flight at once; the API holds the rest back, so a view that fires a
thousand reads is slowed rather than refused.

## Put the package in a file

The file carries the code. Each of the three ways below is a proposal that a person
reviews line by line before accepting, and nothing runs until it is accepted. Each
proposes only what differs from the package the file already carries, and names the
content each change replaces, so a proposal prepared against an older package is
refused rather than replayed over a newer one.

### From Studio

1. Open **Studio → Screens → Custom views**, or **File → Custom views…**.
2. Choose **Import package…**, and pick the folder's `nendo-package.json`, a `.zip` of
   the folder, or a legacy `.nendoview` archive.
3. Nendo reads the whole package, prepares the proposal and opens the review. Its
   **Code** section shows each file: the changed lines of a text file, and the sizes of
   any other.
4. Accept. A view that names the package now runs it.

A placeholder whose package is missing offers the same Import as **Add package to
file…**. Import is refused with `extension-unchanged` when the file already carries the
package exactly. **Export…** writes a package back to a new folder, with its
`nendo-package.json`, so it can be edited and imported again.

### Over MCP

An agent that writes a view's code reads `nendo://application/view-api` first: this
guide's API as the running Nendo has it, generated from the tables `api.js` is built
from, with a whole view to start from. An agent that is not writing a view has no reason
to read it.

An agent at the **Shape app** access level writes the package through an ordinary
change set: take a lease, `nendo.change_set.begin`, add the operations with
`nendo.change_set.add_operations`, and `nendo.change_set.validate`. The person accepts
the proposal in Nendo.

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
  path, later in the same change set. About two parts fit in one call.
- `expectedSha256` makes a put or a removal conditional: the hash the path holds now,
  or `absent` for a path that must be new.
- `extension.removeFile` removes a file, and `extension.removePackage` an empty package.
- The preview's `packageChanges` lists each file as added, replaced or removed, with the
  changed lines the person reads.

Read a package back at `nendo://application/extensions` (each file's path, media type,
SHA-256 and size) and at
`nendo://application/extension/{packageId}/file?path=…&offset=…`, in pages of at most
131,072 bytes. Percent-encode the path, so `tiles/world.bin` is `tiles%2Fworld.bin`,
and follow `nextOffset` until it is null. The example `put-a-custom-view-in-the-file` in
`nendo://application/examples` is a complete change set to copy.

### With `tools/Put-NendoPackage.mjs`

From a clone of this repository, with Nendo running, the file open and agent access at
**Shape app**:

```powershell
node tools/Put-NendoPackage.mjs extensions/systems-lens             # propose the folder
node tools/Put-NendoPackage.mjs extensions/systems-lens --dry-run   # say what it would send
```

The script reads the folder as Import does, finds the running Nendo through the files
it writes under `%LOCALAPPDATA%\Nendo\Mcp\active` (or at the address `--endpoint`
names), proposes only the files that differ, and prints the proposal's title; accept it
in Nendo. `--accept` accepts it only while the file's agent access is **Unattended**.
With more than one Nendo running, name the file with `--application <applicationId>`.
`--title` sets the proposal's title. The script packs the operations into mutations of
up to 16 operations each, fewer when the files are large, and gives the views that show
the package a mutation of their own; each mutation is one revision in History. If the
draft does not validate, the script prints why and leaves the draft open.

## Show it: the view definition

A package runs only where a view definition names it. A definition is a node in the
file's screens, authored with `ui.addNode` in a change set that a person accepts. The
example `show-a-custom-graph` in `nendo://application/examples` defines a graph.

A person can add one without an agent: in **Studio → Screens → Custom views**, each
package's card lists the screens and record pages that show it, and **Add view…** asks
for the kind, a title, the record type (or record page), the label and status fields,
and for a graph the link record type and its two ends. It offers only choices that pass
the checks below and prepares the same `ui.addNode` and `ui.setProperty` operations an
agent would. It writes no pins and an empty configuration, so the file asks for host
1.34.0. Children (`fieldBinding`, `filterClause`) and a configuration are an agent's to
write.

### A screen of records

An `extensionRecordsSurface` is a screen of one record type, and the view fills it. In
Use it is one of that record type's screens, listed by its title.

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
`sourceFieldId` and `targetFieldId`, two distinct Reference fields of the link type that
both point at the node type. A `fieldBinding` under it may name a field of either type.

### A panel on a record page

An `extensionRecordPanel` sits on a record page or a record form, directly under the
`detailSurface` or `recordForm`, or inside a `section`, in a tab or not. It is about
that page's record, so it names no `entityId`, no link type and no filter. A page may
carry as many as it likes.

```json
{ "operationType": "ui.addNode",
  "payload": { "surfaceId": "taskPage", "nodeId": "taskPage.timeline", "parentNodeId": "taskPage",
    "kind": "extensionRecordPanel", "position": 4,
    "properties": { "title": "Timeline", "packageId": "org.nendo.gantt", "labelFieldId": "taskTitle" } } }
```

Here `taskPage` is the record page's root node. Its `fieldBinding` children are the
view's: they never become fields of the form around it.

### A screen of the file

An `extensionView` root makes a view a screen of the file itself, beside the front page,
rather than of one record type. It names `definitionVersion` 3, `title` and `packageId`,
and may name `entityId` (what it is about), `configuration` and `opensFile: true` (the
file opens on it, at most one per file). It takes no fields or filters, and a file holds
up to eight. It needs host 1.42.0.

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

A view may carry `fieldBinding` children, which name further fields to show, stored or
calculated, and, on a screen, `filterClause` children, which narrow its records:
`{fieldId, operator, value}` with an optional `valueKind`. A filter names a stored
field, uses the operators `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull` and
`isNotNull`, and may compare against `today` or `now` through `valueKind`. Note `lte`
and `gte` here, where `records.query` takes `le` and `ge`. A view carries at most 64
children, and each field is shown once. `loadRecords` and `loadGraph` apply the
filters; a query reads at most eight of them. The pins `packageVersion`,
`packageDigest`, `protocolVersion` and `configurationVersion` are not needed, and are
kept and read by nothing when present.

### Configuration

`configuration` is how one view is set up: which field is the start date, a default
zoom, a colour scale. A choice the person changes is a [setting](#settings) of the
package instead. The view reads its configuration parsed:

```json
"configuration": "{\"startField\":\"taskStarts\",\"zoom\":2}"
```

```js
const { startField = null, zoom = 1 } = nendo.context.configuration;
```

Nendo does not interpret it. It is not the place for data.

### What Nendo checks

- An invalid definition is the error `NUI450`, and the change set does not validate.
  The message names what is wrong.
- A package the file does not carry is the warning `NUI452`. The definition waits for
  its code, and the view says "‹package› is not in this file" where it is shown and
  offers **Add package to file…**. Put the package's operations in the same change set
  as the view, in either order, and there is no warning.
- A view needs host 1.34.0 when only the open rules accept it: no pins, a configuration
  with anything in it, a calculated label or field, a `today` or `now` filter, or more
  fields or panels than the earlier rules allowed. A view the earlier rules accept keeps
  its rung, 1.29.0 to 1.32.0, and a file that carries a package needs 1.33.0 in any case
  ([host rungs](contracts/custom-views.md#host-rungs)). The review shows a raise before
  you accept it.

## Running, stopping and debugging

- **Develop from a folder.** Import the package once. Then, in Studio → Screens → Custom
  views, press **Develop from folder…** on its card and pick the package's folder. Every
  view of the package now runs from that folder on this computer, under a Development
  strip, and reloads whenever you save a file there. Nothing reaches the `.nendo` file:
  anyone else, and a copy of the file, runs the code the file carries. **Save to file…**
  prepares the proposal Import would; **Stop developing** puts the file's code back. A
  folder that stops reading as a package shows the reason in the view.
- A view starts when its place comes into view: a screen when you show it, a panel when
  the record page scrolls it near the window. Nothing runs in Studio, in safe mode or
  during recovery.
- **DevTools.** Right-click inside the running view and choose **Inspect**. To run code
  inside the view, choose its frame as the Console's context, in the drop-down that
  starts at `top`. Its requests, storage and `console.log` lines show there too.
- **Not responding.** Nendo pings each view every five seconds, and the API answers for
  you. A view that keeps its main thread busy for ten seconds is marked "This view is
  not responding", with **Stop** and **Reload**. Stop ends every view of the same
  package, because they share one renderer process. Keep long work in a worker or in
  slices.
- **A crash.** If a view's renderer ends, each of its package's views says "This view
  stopped", with **Reload**. The rest of Nendo is unaffected.
- **What an agent sees.** A view's loads, stops, uncaught errors and refused calls are
  kept for the open file at `nendo://application/extension-events`.
  `tools/view-kit/preview.mjs` runs a package against the real script and a fixture
  broker.
- **Switches.** **Run custom views** turns every view off on this device, and **Run this
  file's views** turns off this file's. Both are in Studio → Screens → Custom views. If
  a view brings the whole window down, the recovery panel offers **Restart without
  custom views**, which keeps views off until you turn them on again or start Nendo
  again.
- **Test outside Nendo.** Each example package has a `tools/Review-*.ps1` lane that
  serves it on one origin and the fixture broker, `tools/Graph-FixtureBroker.html`, on
  another, with the real `api.js` between them. The broker offers Nendo's toolbar and
  menus only when the probe asks (`broker.offerChrome(true)`), and refuses a declaration
  Nendo would refuse, named in `broker.chromeRefusals`. Copy one of those lanes for your
  own package. A lane passes only when its probe's own last word, such as `gantt ok`,
  appears under `### Result` and no `### Modal state` does: `run-code` stops at a dialog
  and still exits 0. Give your probe a word of its own.

## What a view can and cannot reach

| A view can | A view cannot |
| --- | --- |
| Read every record type in its file, calculated fields and exact numbers included | Reach Nendo's own page: `parent.document` throws |
| Hear every change to its file | Reach the host bridge: `window.chrome.webview` answers nothing in a frame |
| Use the network, loopback included, and open WebSockets | Use Nendo's MCP endpoint, which refuses browser origins |
| Read and write the clipboard, download files, and read a file the person picks or drops | Reach SQL, a file path, another file or a device setting |
| Keep `localStorage` and IndexedDB, per package and file, on this device | Navigate Nendo away, or load Nendo inside a frame |
| Send a link the person clicks, one that opens a new window, to their own browser | Open a window by script without the person's click |
| Show the browser's `alert`, `confirm` and `prompt` | Choose the name a write is made in, or a key outside its package |
| Create, change and delete records and run record commands, in its package's name | Write under any other name, or without a version check |
| Ask Nendo to open a record, a screen or Studio, show a sentence and size its panel | Accept or reject a proposal, ever |

Browser storage belongs to the view's origin, which is its own for each package in each
file. It stays on this device and does not travel with the file.

A received file's code runs when its view is shown, with these powers. The switches are
the control. The [contract](contracts/custom-views.md#the-trade) states the trade.
