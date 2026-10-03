/**
 * The view API as an agent reads it before it writes a custom view's code (W-094). The api
 * build writes it beside api.js as dist/_nendo/view-api.json, and the local MCP serves that
 * file at nendo://application/view-api, to be read only by an agent writing a view.
 *
 * The names come from the tables api.js and the broker are built from: the broker's methods,
 * the events, the icons, the theme tokens, Nendo's own keys and the limits. A broker method
 * without a line here stops the build, and scripts/view-api-reference.test.mjs holds every
 * function on window.nendo, every toolbar kind and the example to the real modules.
 */
import { brokerMethodNames } from '../extension-broker';
import { themeTokenNames } from '../extension-model';
import { toolbarIcons } from '../view-toolbar-model';
import { apiVersion, extensionLimits, hostKeys, viewEventNames } from './protocol';

interface MethodLine { call: string; params: string; answer: string; note?: string }

const recordAt = '`record` is {entityId, recordId, version}: a record as the view read it, which a record from any read is.';

/** One line per broker method, in the words a view's author calls it by. */
const methodLines: Readonly<Record<string, MethodLine>> = {
  'schema.describe': {
    call: 'nendo.schema.describe()',
    params: 'None.',
    answer: '{purpose, changeSequence, entities, screens, commands}. An entity is {entityId, displayName, fields, hierarchy}; a field {fieldId, displayName, storageKind, required, presentation, calculated, expression, choices, reference, scale}, where a choice is {id, displayName, retired, tone} and reference is {targetEntityId, labelFieldId}. hierarchy is {parentFieldId, orderFieldId} or null. A screen is {id, surfaceId, kind, title, entityId}; a command {id, entityId, label, steps}, each step {fieldId, valueKind, value}.',
    note: 'Retired record types and fields are left out. storageKind is text, integer, decimal, boolean, date, dateTime, uuid or reference.',
  },
  'records.query': {
    call: 'nendo.records.query(query)',
    params: '{entityId, limit?, cursor?, filters?, sortFieldId?, descending?}. limit is 1 to 200, 100 by default; cursor is the previous page\'s nextCursor; filters as under filters.',
    answer: '{items, nextCursor, changeSequence}: items are records, and nextCursor is null on the last page.',
    note: 'Without sortFieldId, records come in record-ID order. A change to the file between pages refuses the next one with stale-cursor: start again from the first page, as queryAll does. A filter or sort on a calculated field works out every record it could match first, and is refused as calculated-query-too-wide past 10,000 of them.',
  },
  'records.get': {
    call: 'nendo.records.get(entityId, recordId)',
    params: 'The record type and the record\'s ID.',
    answer: 'The record, or null when there is none.',
  },
  'records.tree': {
    call: 'nendo.records.tree(query)',
    params: '{entityId, rootRecordId?, depth?, limit?, cursor?}: the records under rootRecordId, or from the top level, down to depth levels (1 to 32, 1 by default).',
    answer: '{items, nextCursor, changeSequence}, depth-first in sibling order. Each item is {record, parentRecordId, depth, childCount}.',
    note: 'Only for a record type that declares a tree: schema.describe names its parent field in hierarchy.',
  },
  'records.count': {
    call: 'nendo.records.count(query)',
    params: '{entityId, filters?}.',
    answer: '{entityId, count, changeSequence}.',
  },
  'records.aggregate': {
    call: 'nendo.records.aggregate(query)',
    params: '{entityId, aggregate, fieldId, filters?}. aggregate is count, sum, min or max.',
    answer: '{entityId, aggregate, fieldId, value, valueLexeme, contributingRecords, changeSequence}. value is null over records that hold no value; valueLexeme keeps its exact digits.',
    note: 'There is no average: an exact mean is not generally an exact decimal. Divide sum by count yourself.',
  },
  'records.groupAggregate': {
    call: 'nendo.records.groupAggregate(query)',
    params: '{entityId, groupByFieldId, aggregate, fieldId?, filters?}.',
    answer: '{entityId, groupByFieldId, aggregate, fieldId, groups, unrecognised, changeSequence}. Each group is {key, value, valueLexeme, contributingRecords}; unrecognised counts records whose value is none of the field\'s options.',
  },
  'records.bucketAggregate': {
    call: 'nendo.records.bucketAggregate(query)',
    params: '{entityId, dateFieldId, bucket, range, aggregate, fieldId?, filters?}. bucket is day, week or month; range is last30Days, last90Days, last6Months, last12Months, lastTwelveMonths or thisYear.',
    answer: '{entityId, dateFieldId, bucket, range, aggregate, fieldId, start, end, groups, changeSequence}: one group per bucket of the range, each {key, value, valueLexeme, contributingRecords}. start and end are the dates the range resolved to.',
  },
  'records.cellAggregate': {
    call: 'nendo.records.cellAggregate(query)',
    params: '{entityId, rowByFieldId, columnByFieldId, aggregate, fieldId?, filters?}: two different fields.',
    answer: '{entityId, rowByFieldId, columnByFieldId, aggregate, fieldId, rowKeys, columnKeys, cells, unrecognised, changeSequence}. Each cell is {rowKey, columnKey, value, valueLexeme, contributingRecords}.',
  },
  'records.create': {
    call: 'nendo.records.create(entityId, values, options?)',
    params: 'values as under values. options is {recordId?, targetVersions?}, or a record ID alone. Without recordId, Nendo makes one.',
    answer: 'The record as it now stands, with version 1.',
  },
  'records.update': {
    call: 'nendo.records.update(record, values, options?)',
    params: `${recordAt} values holds only the fields to change. options is {targetVersions?}.`,
    answer: 'The record as it now stands, with its new version.',
  },
  'records.delete': {
    call: 'nendo.records.delete(record)',
    params: recordAt,
    answer: 'null.',
    note: 'Refused with record-referenced while other records point at it.',
  },
  'records.batch': {
    call: 'nendo.records.batch(writes, options?)',
    params: 'writes is a list of 1 to 200 record writes, each {op: \'create\', entityId, recordId?, values, targetVersions?}, {op: \'update\', entityId, recordId, version, values, targetVersions?} or {op: \'delete\', entityId, recordId, version}. options is {label?}: what History calls the revision, 1 to 80 characters.',
    answer: '{records}: each {entityId, recordId, version} in the order written, version null for a deleted record.',
    note: 'One revision: every write commits or none does. A record appears at most once. A reference to a record the batch creates or updates earlier needs no target version. A move is not part of a batch; set a tree\'s parent and order fields in an update instead, or use records.move.',
  },
  'records.move': {
    call: 'nendo.records.move(record, to)',
    params: `${recordAt} to is {parentRecordId, parentVersion?, beforeRecordId?}: parentRecordId null for the top level, otherwise with the parent's version as the view read it; beforeRecordId a sibling to go before, or last without one.`,
    answer: 'The record as it now stands.',
    note: 'Only in a record type that declares a tree. The subtree moves with it. A move under the record\'s own descendants, or one past 32 levels, is refused.',
  },
  'commands.run': {
    call: 'nendo.commands.run(commandId, record)',
    params: `commandId from schema.describe's commands. ${recordAt}`,
    answer: 'The record as it now stands.',
    note: 'A command is spent on a record when every step with a literal or null value already holds it; Nendo greys its own button then.',
  },
  'proposals.prepare': {
    call: 'nendo.proposals.prepare(title, operations)',
    params: 'title of 1 to 200 characters; operations, 1 to 128 canonical operations {operationType, payload, operationId?} from nendo://application/vocabulary.',
    answer: '{proposalId, title, state, diagnostics, opened}. opened is false when Nendo could not show the review at once; proposals.open shows it later.',
    note: 'A definition change in the package\'s name, which the person accepts or rejects in Nendo\'s review. One proposal of a package waits at a time: another is refused with proposal-waiting.',
  },
  'proposals.get': {
    call: 'nendo.proposals.get(proposalId)',
    params: 'A proposal this package prepared in this session.',
    answer: '{proposalId, title, state, diagnostics}. state is previewable, invalid, stale, active once accepted, rejected or failed.',
  },
  'proposals.open': {
    call: 'nendo.proposals.open(proposalId)',
    params: 'A proposal this package prepared in this session.',
    answer: '{proposalId, title, state, diagnostics, opened}.',
  },
  'state.get': {
    call: 'nendo.state.get(key, options?)',
    params: 'key of 1 to 128 characters. options is {scope?}: view (the default) keeps a value for this view, package for all the package\'s views.',
    answer: '{key, value, version}, or null when the key has no value.',
  },
  'state.keys': {
    call: 'nendo.state.keys(options?)',
    params: '{scope?}.',
    answer: '[{key, version}], without the values.',
  },
  'state.set': {
    call: 'nendo.state.set(key, value, options?)',
    params: 'value is JSON of at most 64 KiB. options is {scope?, expectedVersion?}: the key\'s version, or 0 for a key that must not exist yet; without it, the last write wins.',
    answer: '{key, value, version}.',
    note: 'Kept in the file, so a copy carries it, and named in History. api.js sends a view\'s writes at most twice a second and joins writes to one key made meanwhile. A stale expectedVersion is refused with state-version-conflict.',
  },
  'state.delete': {
    call: 'nendo.state.delete(key, options?)',
    params: '{scope?, expectedVersion?}, as for set.',
    answer: 'null.',
  },
  'ui.openRecord': {
    call: 'nendo.ui.openRecord(entityId, recordId)',
    params: 'The record to open.',
    answer: '{opened}.',
    note: 'Opens the record on its Use page when there is one, otherwise in Studio. Nothing moves while another action runs (busy) or a record page holds unsaved typing (not-allowed).',
  },
  'ui.openScreen': {
    call: 'nendo.ui.openScreen(surfaceId)',
    params: 'A screen\'s id or surfaceId from schema.describe; the front page is a screen too.',
    answer: '{opened}.',
  },
  'ui.openStudio': {
    call: 'nendo.ui.openStudio(entityId?)',
    params: 'A record type to open Studio\'s Data view on, or none.',
    answer: '{opened}.',
  },
  'ui.toast': {
    call: 'nendo.ui.toast(text)',
    params: 'text of 1 to 300 characters.',
    answer: 'null.',
    note: 'Shown in Nendo\'s outcome line as "view title: text", at most one a second.',
  },
  'ui.setHeight': {
    call: 'nendo.ui.setHeight(pixels)',
    params: 'The height the view wants, bounded to 80 to 4,000.',
    answer: '{pixels}: the height it now has.',
    note: 'A panel on a record page starts 360 pixels tall until it sets one. A screen fills its area.',
  },
  'ui.setToolbar': {
    call: 'nendo.ui.setToolbar(toolbar)',
    params: '{items, add?}, or the list of items alone, as under toolbar. add names the command Nendo\'s own Add button runs on this view\'s screen.',
    answer: 'null.',
    note: 'Each call replaces the last, and an empty list removes the toolbar. A press arrives as the event command. Check nendo.has(\'ui.setToolbar\') first: an older Nendo leaves a view to draw its own controls.',
  },
  'ui.showMenu': {
    call: 'nendo.ui.showMenu(items, at)',
    params: 'Menu items as under toolbar.menuItems; at is {x, y} in the view\'s own pixels, or the mouse event itself.',
    answer: '{id, value} of the item picked, or null when the menu is dismissed. value is a check\'s new state or a radio item\'s value.',
    note: 'Nendo draws its own menu at that point, for a right-click or a button of the view\'s own.',
  },
  'ui.setPlace': {
    call: 'nendo.ui.setPlace(place, {label?, replace?})',
    params: 'Where the view is: JSON of at most 4 KiB, such as {view: id, selected: id}. label names it on Nendo\'s Back button, at most 80 characters; the view\'s title when left out. replace corrects the step the person is on rather than making one.',
    answer: 'null.',
    note: 'A new place is a step in Back and Forward; use replace for a selection and for the place the view starts at. Declaring the place it already has does nothing, so a view may declare its place after restoring it. Back and Forward hand a place back as the event place, and a view that has to start again finds it in context.place. At most twenty a second. Check nendo.has(\'ui.setPlace\') first.',
  },
};

/** What api.js adds on top of the method table: no method of their own. */
const helperLines: readonly Omit<MethodLine, 'params'>[] = [
  { call: 'nendo.ready', answer: 'A promise of the context, once Nendo has connected the view. Rejects with not-framed in a page opened outside Nendo.' },
  { call: 'nendo.context', answer: 'The latest context, or null before ready.' },
  { call: 'nendo.apiVersion', answer: 'The version of this API: 1.' },
  { call: 'nendo.has(name)', answer: 'Whether this Nendo answers a method, from context.methods. Feature-detect anything added later this way.' },
  { call: 'nendo.on(name, listener)', answer: 'Hears an event, as under events; answers a function that stops hearing it. Any other name throws unknown-event.' },
  { call: 'nendo.changes.subscribe(listener)', answer: 'The same as nendo.on(\'changes\', listener).' },
  { call: 'nendo.records.queryAll(query, options?)', answer: 'Every record of records.query, a page of 200 at a time, up to options.max (10,000 by default). When the file changes between pages it reads again from the top, at most three times, then fails with stale-cursor.' },
  { call: 'nendo.records.treeAll(query, options?)', answer: 'Every node of records.tree the same way.' },
  { call: 'nendo.view.loadRecords()', answer: 'The records the view is about: its record type under its authored filters, with today and now resolved as it reads; on a record page, that page\'s one record.' },
  { call: 'nendo.view.loadGraph()', answer: '{nodes, edges, fields, hiddenEdges}. A node is {id, label, status, values, record}, an edge {id, source, target, values, record}; values holds the fields the view binds. An edge whose ends are not both among the nodes is left out and counted in hiddenEdges. fields names each bound field with its record type, display name and storage kind.' },
  { call: 'nendo.ui.theme', answer: 'The latest {mode, tokens}.' },
  { call: 'nendo.NendoError', answer: 'The class every refusal is: an Error with a stable code, as under refusals.' },
];

/** A whole view that runs as it stands: the steps above in the order a view takes them. */
const example = {
  'index.html': [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="view.css">',
    '<ul id="list"></ul>',
    '<script src="/_nendo/api.js"></script>',
    '<script src="view.js"></script>',
    '',
  ].join('\n'),
  'view.css': [
    'body { margin: 0; padding: 12px; background: var(--nendo-canvas); color: var(--nendo-ink); font: 13px system-ui, sans-serif; }',
    'li { cursor: pointer; padding: 4px 0; border-bottom: 1px solid var(--nendo-line); }',
    '',
  ].join('\n'),
  'view.js': [
    'async function draw() {',
    '  const records = await nendo.view.loadRecords();',
    '  const label = nendo.context.bindings.labelFieldId;',
    '  document.getElementById(\'list\').replaceChildren(...records.map((record) => {',
    '    const item = document.createElement(\'li\');',
    '    item.textContent = String(record.labels[label] ?? record.values[label] ?? \'\');',
    '    item.onclick = () => nendo.ui.openRecord(record.entityId, record.recordId);',
    '    return item;',
    '  }));',
    '}',
    '',
    'nendo.ready.then(async () => {',
    '  if (nendo.has(\'ui.setToolbar\')) {',
    '    nendo.on(\'command\', (command) => { if (command.id === \'refresh\') draw(); });',
    '    await nendo.ui.setToolbar([{ kind: \'button\', id: \'refresh\', label: \'Refresh\', icon: \'refresh\', iconOnly: true, keys: \'Alt+R\' }]);',
    '  }',
    '  nendo.changes.subscribe(draw);',
    '  await draw();',
    '});',
    '',
  ].join('\n'),
};

/** The whole reference, as nendo://application/view-api answers it. */
export function viewApiReference() {
  const documented = Object.keys(methodLines);
  const missing = brokerMethodNames.filter((name) => !documented.includes(name));
  const unknown = documented.filter((name) => !brokerMethodNames.includes(name));
  if (missing.length > 0 || unknown.length > 0)
    throw new Error(`The view API reference is out of step with the broker's method table. Without a line: ${missing.join(', ') || 'none'}. Not in the table: ${unknown.join(', ') || 'none'}. Edit src/extension-api/reference.ts.`);

  return {
    apiVersion,
    readWhen: 'Only while you write a custom view\'s code. Nothing else needs this: records, screens and change sets are described by nendo://application/describe, nendo://application/vocabulary and nendo://application/examples.',
    about: 'A custom view is a web page that a .nendo file carries as a package, shown on a screen or a record page. Nendo runs it in a sandboxed frame of its own window, on an origin of its own, and the page reaches the file only through window.nendo, which /_nendo/api.js defines. A view reads every record, writes records under version checks, runs the file\'s commands, keeps small state with the file, prepares proposals for the person and puts its controls in Nendo\'s toolbar. It can also use the network, the clipboard, files the person chooses or drops on it, downloads and browser storage of its own. A copy of the file runs its views wherever it is opened, and nobody there reads the code first: keep it plain enough to review.',
    start: [
      'Write plain HTML, CSS and JavaScript, or a bundler\'s output: nothing builds in Nendo. Paths are relative, and nothing may sit under _nendo/.',
      'Load the API before your own script, with <script src="/_nendo/api.js"></script>. Every view\'s origin serves it; never copy it into the package.',
      'Await nendo.ready, which resolves with the context. Then read, draw, and draw again on the changes event.',
      'Put the files in the file with a change set: extension.setPackage {packageId, title, entryPoint, version}, then one extension.putFile per file. nendo://application/vocabulary has the payloads under operations and the bounds under limits.extensions, and a file larger than one payload goes in parts with append.',
      'Show the package with a view definition that names it by packageId: an extensionRecordsSurface or extensionGraphSurface root is a screen of its record type, an extensionView root is a screen of the file beside the front page (with opensFile, the file opens on it), and an extensionRecordPanel is a panel on a record page. The vocabulary lists each kind\'s properties; nendo://application/examples has put-a-custom-view-in-the-file and show-a-custom-graph to copy.',
      'A package is reviewed as code. At Unattended, nendo.change_set.accept applies your own proposal; below it, the person accepts it in Nendo. Read the files back at nendo://application/extensions.',
    ],
    example,
    develop: 'A person can run a package from a folder instead of the file, so every save reloads its views: Studio › Surfaces › Custom views › Develop from folder…, once the file carries the package. The folder holds the files and a nendo-package.json of {packageId, title, version, entryPoint, description}; Save to file… turns the folder into a proposal. The same folder imports a new package through Import package…. Nothing over MCP starts or reads a development link.',
    debug: 'A right-click in a view opens the browser\'s menu with Inspect, and DevTools work in every build: console errors are there, not in any MCP read. A view that throws, hangs or crashes stays with itself; Nendo shows it stopped, with Reload.',
    files: 'To read a file the person chooses, use the browser\'s own <input type="file"> in your page. Clicked by the person, it opens Windows\' Open dialog. The file arrives as a File, with its name, size and bytes and never its path; read it with file.text() or file.arrayBuffer(). accept filters the dialog, but the person can still choose All files, so check what you got; cancel fires when nothing is chosen. A file dropped on the view is yours when you call preventDefault() on dragover; read it from the drop event\'s dataTransfer.files. showOpenFilePicker, showSaveFilePicker and showDirectoryPicker are refused in a view. To save a file, download it: an <a download> link to a Blob URL.',
    clipboard: 'navigator.clipboard reads and writes. A command chosen in Nendo\'s toolbar reaches your frame without focus, and the browser refuses a clipboard write there ("Document is not focused."): call window.focus() first. A key pressed inside the view leaves focus there. For a picture, pass ClipboardItem a promise of the PNG blob.',
    runs: 'Views run in Nendo Desktop only, while custom views are on for the device and the file; the person turns them off in Studio › Surfaces › Custom views, and a view then shows why it is not running. Each package in each file has its own origin, so its browser storage survives a restart and is not shared with another file. A frame starts when its place comes into view and keeps running across Nendo\'s redraws; an accepted change to the package restarts it on the new code.',
    context: {
      apiVersion: 'The API version, 1.',
      viewId: 'The view definition\'s node ID.',
      kind: 'extensionGraphSurface, extensionRecordsSurface, extensionView or extensionRecordPanel.',
      placement: 'screen, or recordPage for a panel on a record page.',
      title: 'The view\'s title.',
      packageId: 'The package the view runs.',
      entityId: 'The record type the view is about; on a record page, the page\'s.',
      recordId: 'The page\'s record for a panel on a record page; null elsewhere.',
      bindings: '{labelFieldId, statusFieldId, edgeEntityId, sourceFieldId, targetFieldId, fields, filters}, as the definition names them. fields is [{fieldId, entityId}] in authored order. filters is [{fieldId, entityId, operator, value, valueKind, storageKind}], operator already a query word; valueKind is literal, or today or now, which loadRecords resolves as it reads.',
      configuration: 'The definition\'s configuration, parsed; {} when there is none. Nendo does not interpret it.',
      theme: '{mode, tokens}: light or dark, and the colour tokens under theme.',
      locale: 'The browser\'s language, or en.',
      readOnly: 'True when the open file takes no edits. Writes, state and proposals are then refused with read-only.',
      methods: 'Every method this Nendo answers, which nendo.has reads.',
    },
    record: {
      shape: '{entityId, recordId, version, values, exact, labels, calculated}.',
      values: 'Plain JSON by field ID: text, a number, true or false, a date as yyyy-MM-dd, an instant as an ISO timestamp, a choice as its option ID, a reference as the target record\'s ID, and a calculated field as its value, or null when it has none.',
      exact: 'The exact digits of every numeric value, stored or calculated, which a JavaScript number can round.',
      labels: 'For each reference field, the label of the record it points at.',
      calculated: 'Each calculated field: {state, value, exact, errorCode, errorMessage}, state being value, empty, error or pending.',
      version: 'The record version. A write names the version it read and is refused with record-version-conflict when the record changed since; read it again.',
    },
    methods: brokerMethodNames.map((name) => ({ method: name, ...methodLines[name] })),
    helpers: helperLines,
    events: {
      context: 'The context, on every connect and whenever it changes, for example after the definition changed.',
      theme: '{mode, tokens}, when the person\'s theme turns light or dark. api.js has already applied it.',
      changes: 'The file\'s change sequence, when anything commits to the file: at most one every 250 ms, carrying the latest. It is a nudge; the view decides what to read again.',
      place: 'The view\'s place as it declared it with ui.setPlace, or null for none: Back or Forward moved the person there. Show that place; declaring it again does nothing.',
      command: '{id, value, source}: the person pressed one of the view\'s controls. source is toolbar, menu, palette (Ctrl K), key or add. value is a toggle\'s or a check\'s new state, the option chosen, the text searched for, a radio item\'s value, or null for a button or a menu item.',
      names: viewEventNames,
    },
    filters: {
      shape: '{fieldId, operator, value}, with no value for isNull and isNotNull. Clauses combine with and.',
      operators: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'contains', 'isNull', 'isNotNull', 'descendantOf'],
      notes: [
        'These are the query words. The vocabulary\'s lte and gte belong to a filterClause in a view definition, and records.query refuses them.',
        'Compared exactly, by the field\'s storage kind; contains matches text ignoring case.',
        'descendantOf takes a record ID and matches every record under it, on the parent field of a declared tree.',
        'Eight clauses at most in one read, and none on a calculated field.',
      ],
    },
    values: {
      kinds: 'Each value is null, text, true or false, a number, or {"$nendoNumber": "digits"} for a decimal a JavaScript number would round. A date is yyyy-MM-dd, an instant an ISO timestamp with its offset, a choice its option ID, a reference the target record\'s ID. At most 64 fields in one write.',
      targetVersions: 'A write that points a reference field at a record passes that record\'s version as the view read it, {fieldId: version}. The host refuses a reference without one (target-version-required), and one whose target changed since (target-version-conflict).',
      attribution: 'History names the package on each write, state change and accepted proposal, and the person can undo a write there. Nendo asks nobody to agree to a view\'s write; a view that wants the person to agree first asks them itself.',
    },
    toolbar: {
      kinds: {
        button: '{kind, id, label, icon?, iconOnly?, keys?, disabled?}',
        toggle: '{kind, id, label, pressed?, icon?, iconOnly?, keys?, disabled?}',
        choice: `{kind, id, label, hideLabel?, options, value?, disabled?}: segments, at most ${extensionLimits.choiceOptions} options of {value, label, disabled?}`,
        select: `{kind, id, label, hideLabel?, options, value?, disabled?}: a labelled select of at most ${extensionLimits.selectOptions} options`,
        search: '{kind, id, label, placeholder?, value?, keys?, disabled?}: its text arrives after 180 ms of rest, and at once on Enter',
        menu: '{kind, id, label, icon?, iconOnly?, disabled?, items}: items as under menuItems',
        group: `{kind, label, items}: a joined row of at most ${extensionLimits.groupItems} buttons and toggles`,
        text: '{kind, text, mono?}: a line of text that gives way to the controls rather than wrap',
        separator: '{kind}',
        spacer: '{kind}',
      },
      menuItems: {
        item: '{kind?, id, label, detail?, icon?, keys?, disabled?, danger?}: kind item is the default',
        check: '{kind, id, label, checked?, keys?, disabled?}',
        radio: '{kind, id, value, label, checked?, disabled?}: the items of one set share an id',
        label: '{kind, label}',
        separator: '{kind}',
      },
      rules: [
        'An id is 1 to 64 letters, digits and . _ : -, starting with a letter or a digit. No two controls share one, except the items of one radio set.',
        `A label or an option is 1 to ${extensionLimits.labelCharacters} characters and a detail line at most ${extensionLimits.detailCharacters}; words are text, never markup.`,
        `At most ${extensionLimits.toolbarItems} controls and ${extensionLimits.menuItems} menu items, in at most ${extensionLimits.toolbarBytes / 1024} KiB of JSON.`,
        'A declaration that breaks a rule is refused whole with invalid-params naming the rule, and Nendo keeps drawing the last one it accepted.',
        'Nendo shows the new state of a pressed control at once; the view\'s next declaration decides it. A view that reloads declares its toolbar again.',
        'On a screen the controls sit in Nendo\'s row under the top bar, before Add; on a record page, in the panel\'s header. Ctrl K lists them under the view\'s title.',
        'Nendo\'s row keeps to one line: controls that do not fit go, from the end, into Nendo\'s More menu (a toggle as a check, a menu\'s or a group\'s items under its label, a select\'s or a choice\'s options as radio items) and come back as the row widens. A search box stays; a text gives way. A choice made in More reaches the view as a command with source menu.',
      ],
      keys: 'Ctrl, Alt and Shift in that order, then one key: a letter, a digit, a symbol, Plus, an arrow, Home, End, PageUp, PageDown, Delete, Backspace, Enter, Space, or F2 to F12, as "Ctrl+Shift+F" or "Alt+ArrowUp". Every key but F2 to F12 needs Ctrl or Alt. No two controls declare one key, and Nendo\'s own keys cannot be declared: pressed in a view, api.js hands those to Nendo.',
      hostKeys,
      icons: toolbarIcons,
    },
    theme: {
      how: 'api.js sets each token as a custom property on the document\'s root, --nendo-<token>, sets data-nendo-theme to light or dark, and adds a color-scheme meta after any of the view\'s own. Draw with var(--nendo-ink) and the rest and a view follows the person\'s theme without listening for it.',
      tokens: themeTokenNames,
    },
    limits: extensionLimits,
    refusals: {
      'invalid-params': 'A parameter breaks its rule; the message names it.',
      'too-large': 'The parameters take more than 256 KiB.',
      busy: 'Too many requests wait, a second toast or menu came too soon, or Nendo is running another action. Try again shortly.',
      'views-off': 'Custom views were turned off while the request waited.',
      'read-only': 'The open file takes no edits.',
      'not-allowed': 'A record page holds unsaved typing, so Nendo stays where it is.',
      'not-found': 'The record type or the screen is not in this file.',
      'record-version-conflict': 'The record changed since the view read it. Read it again.',
      'record-referenced': 'Other records still point at the record being deleted.',
      'target-version-required': 'A reference was written without its target\'s version in targetVersions.',
      'target-version-conflict': 'A reference\'s target changed since the view read it.',
      'stale-cursor': 'The file changed between pages. Read again from the first page.',
      'proposal-waiting': 'A proposal of this package already waits for the person.',
      'proposal-not-found': 'Not a proposal this package prepared in this session.',
      'state-version-conflict': 'The key changed since the version the write expected.',
      'state-too-large': 'A key, a value or the package\'s state is past its bound.',
      'actor-not-allowed': 'The file does not carry this view\'s package any more.',
      'unknown-method': 'Not a method this Nendo answers. Check nendo.has first.',
      disconnected: 'Nendo reconnected the view while the request waited. Send it again.',
      'not-framed': 'The page was opened on its own, outside Nendo.',
      'unknown-event': 'nendo.on was given a name that is not an event.',
      failed: 'The answer could not be sent, or the failure had no code of its own.',
      other: 'Any other code is the host\'s own, such as validation or value-not-unique, with a message that names the remedy.',
    },
    cannot: [
      'reach Nendo\'s own page, whose document is another origin, or its host bridge',
      'use SQL, a file path, another file, a device setting or Nendo\'s MCP endpoint',
      'navigate Nendo away or frame Nendo inside itself',
      'write under any name but its own package\'s',
      'accept or reject a proposal',
    ],
  };
}
