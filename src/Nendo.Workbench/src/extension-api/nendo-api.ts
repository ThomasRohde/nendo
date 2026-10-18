/**
 * window.nendo: the API a custom view's own code calls (ADR-0013). The host serves this file
 * at /_nendo/api.js on every view origin, and a package takes it with one script tag:
 * `<script src="/_nendo/api.js"></script>`.
 *
 * It talks to the Workbench that framed it over a MessagePort the Workbench hands it, and to
 * nothing else: no host object, no bridge, no file path. The Workbench checks every request
 * against a closed method table and answers it through the same typed services the rest of
 * the app uses, so what a view can do is exactly what that table lists.
 *
 * Nothing here is exported. The build wraps it in one function, and the page sees only
 * `window.nendo`.
 */
import { isPeriod, resolveClauseValue, resolvePeriodClause } from '../record-window';
import {
  apiVersion, chordOf, extensionLimits, hostKeys, normalizeKeys, utf8Length, viewEventNames,
  type ConnectMessage, type HelloMessage, type Json, type KeyEventLike, type PortMessage, type SchemaDescription, type SchemaField,
  type ViewContext, type ViewEventName, type ViewGraph, type ViewPage, type ViewRecord, type ViewSearchPage, type ViewTheme, type ViewTreeNode, type ViewTreePage,
} from './protocol';

type Listener = (data: never) => void;
type Query = Record<string, unknown>;
interface Waiting { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/** A refusal, with the stable code the Workbench or the host gave it. */
class NendoError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NendoError';
    this.code = code;
  }
}

function isContext(value: unknown): value is ViewContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ViewContext>;
  return typeof candidate.viewId === 'string' && Array.isArray(candidate.methods) &&
    typeof candidate.bindings === 'object' && candidate.bindings !== null;
}

/** Whether a key pressed at this target is typing: a field keeps its own keys. */
function typing(target: unknown): boolean {
  const element = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown } | null;
  if (element === null || typeof element !== 'object') return false;
  if (element.isContentEditable === true) return true;
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(String(element.type ?? 'text'));
}

type KeyEvent = KeyEventLike & { repeat?: boolean; defaultPrevented?: boolean; target?: unknown; isComposing?: boolean;
  preventDefault(): void; stopImmediatePropagation(): void };

/** The keys a declaration names on controls a person can press, as the broker will read them. */
function keysOf(items: unknown): Set<string> {
  const found = new Set<string>();
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as { kind?: unknown; keys?: unknown; disabled?: unknown; items?: unknown };
      if (item.disabled === true) continue;
      const keys = normalizeKeys(item.keys);
      if (keys !== null && item.kind !== 'radio' && item.kind !== 'label') found.add(keys);
      if (item.kind === 'group' || item.kind === 'menu') visit(item.items);
    }
  };
  visit(items);
  return found;
}

/**
 * The Workbench's colours, as custom properties on this document's root: `--nendo-ink`,
 * `--nendo-surface`, `--nendo-tone-blue` and the rest, with `data-nendo-theme` naming the
 * mode. A view that draws with them follows the person's theme without listening for it.
 *
 * The mode also becomes the page's default colour scheme, through a color-scheme meta
 * element placed after any of the view's own: the first one in the document wins, so a
 * view that states its own scheme keeps it.
 */
function applyTheme(theme: ViewTheme | undefined): void {
  if (theme === undefined || typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(`--nendo-${name}`, value);
  root.dataset.nendoTheme = theme.mode;
  const head = document.head;
  if (head === null) return;
  let scheme = head.querySelector<HTMLMetaElement>('meta[name="color-scheme"][data-nendo]');
  if (scheme === null) {
    scheme = document.createElement('meta');
    scheme.name = 'color-scheme';
    scheme.dataset.nendo = '';
    head.append(scheme);
  }
  scheme.content = theme.mode;
}

/**
 * Every item of a paged read, up to `max`, read again from the top when the file changes
 * between pages: a stale or unknown cursor ends the continuation, and three tries end the read.
 */
async function readAll<T>(
  call: <R>(method: string, params?: unknown) => Promise<R>, method: string, query: Query, options: { max?: number },
): Promise<T[]> {
  const max = Math.max(1, Math.floor(options.max ?? 10_000));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const items: T[] = [];
    let cursor: string | null = null;
    try {
      do {
        const page: { items: T[]; nextCursor: string | null } =
          await call<{ items: T[]; nextCursor: string | null }>(method, { ...query, cursor, limit: extensionLimits.maximumPageLimit });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null && items.length < max);
      return items.slice(0, max);
    } catch (error) {
      // A file that changes between pages ends the continuation; read again from the top.
      if (!(error instanceof NendoError) || (error.code !== 'stale-cursor' && error.code !== 'invalid-cursor')) throw error;
    }
  }
  throw new NendoError('stale-cursor', 'The file kept changing while the view read it. Read again when it settles.');
}

/**
 * The view's records as nodes and its link records as edges between them, from what the three
 * reads returned. A link whose source or target is not among the nodes is left out and counted.
 */
function graphOf(view: ViewContext, schema: SchemaDescription, nodeRecords: ViewRecord[], edgeRecords: ViewRecord[]): ViewGraph {
  const bindings = view.bindings;
  const edgeEntityId = bindings.edgeEntityId;
  const fieldOf = (entityId: string, fieldId: string): SchemaField | undefined =>
    schema.entities.find((entity) => entity.entityId === entityId)?.fields.find((field) => field.fieldId === fieldId);
  const pick = (record: ViewRecord, fieldIds: string[]): { [fieldId: string]: Json } =>
    Object.fromEntries(fieldIds.map((fieldId) => [fieldId, record.values[fieldId] ?? null]));
  const text = (record: ViewRecord, fieldId: string): string => {
    const label = record.labels[fieldId];
    if (typeof label === 'string') return label;
    const value = record.values[fieldId];
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return fieldOf(record.entityId, fieldId)?.choices.find((choice) => choice.id === value)?.displayName ?? value;
    return record.exact[fieldId] ?? (typeof value === 'object' ? JSON.stringify(value) : String(value));
  };
  const nodeFields = bindings.fields.filter((field) => field.entityId === view.entityId).map((field) => field.fieldId);
  const edgeFields = bindings.fields.filter((field) => field.entityId === edgeEntityId).map((field) => field.fieldId);
  const nodes = nodeRecords.map((record) => ({
    id: record.recordId,
    label: bindings.labelFieldId === null ? '' : text(record, bindings.labelFieldId),
    status: bindings.statusFieldId === null ? null : record.values[bindings.statusFieldId] ?? null,
    values: pick(record, nodeFields),
    record,
  }));
  const known = new Set(nodes.map((node) => node.id));
  const edges: ViewGraph['edges'] = [];
  let hiddenEdges = 0;
  for (const record of edgeRecords) {
    const source = bindings.sourceFieldId === null ? null : record.values[bindings.sourceFieldId];
    const target = bindings.targetFieldId === null ? null : record.values[bindings.targetFieldId];
    if (typeof source !== 'string' || typeof target !== 'string' || !known.has(source) || !known.has(target)) {
      hiddenEdges += 1;
      continue;
    }
    edges.push({ id: record.recordId, source, target, values: pick(record, edgeFields), record });
  }
  const fields = bindings.fields.map(({ fieldId, entityId }) => {
    const field = fieldOf(entityId, fieldId);
    return { fieldId, entityId, displayName: field?.displayName ?? fieldId, storageKind: field?.storageKind ?? 'text' };
  });
  return { nodes, edges, fields, hiddenEdges };
}

/** A record as a write names it: which one, and the version the view last read. */
type RecordAt = { entityId: string; recordId: string; version: number };
/** Field values to write: null, text, true or false, a number, or { $nendoNumber: '…' } for exact digits. */
type WriteValues = Record<string, string | number | boolean | null | { $nendoNumber: string }>;
/**
 * For each reference field a write points at a record, that record's version as the view read
 * it: { owner: person.version }. The host refuses a non-null reference without one, and one
 * whose target changed since.
 */
type TargetVersions = Record<string, number>;
type CreateOptions = { recordId?: string; targetVersions?: TargetVersions };
type UpdateOptions = { targetVersions?: TargetVersions };
/** One record's part of a batch: create, update or delete, as the single-record calls take them. */
type BatchWrite =
  | { op: 'create'; entityId: string; recordId?: string; values: WriteValues; targetVersions?: TargetVersions }
  | { op: 'update'; entityId: string; recordId: string; version: number; values: WriteValues; targetVersions?: TargetVersions }
  | { op: 'delete'; entityId: string; recordId: string; version: number };
type BatchOptions = { label?: string; writeKey?: string; offerUndo?: boolean };
type BatchAnswer = { records: { entityId: string; recordId: string; version: number | null }[]; revision: string | null };
type UndoOptions = { label?: string };
type MoveTarget = { parentRecordId: string | null; parentVersion?: number; beforeRecordId?: string | null };
type StateOptions = { scope?: 'view' | 'package' };
type StateEntry = { key: string; value: unknown; version: number };

type MenuPoint = { x: number; y: number } | { clientX: number; clientY: number };

type ProposalAnswer = { proposalId: string; title: string; state: string; diagnostics: Array<{ code: string; message: string; severity: string }>; opened?: boolean };

function install(host: Window & { nendo?: unknown }): void {
  // Taken twice, the second copy would answer a second connect and strand the first's calls.
  // The first copy is known by its own property and its apiVersion: an element with id or name
  // "nendo" is window.nendo too, through the window's named access, and taken for a first copy
  // it left the view never connecting and nendo.ready undefined, with nothing said (WXS-16).
  // Named access is not an own property of the window, so the API defined below shadows it.
  const existing = Object.prototype.hasOwnProperty.call(host, 'nendo') ? host.nendo : undefined;
  if (typeof existing === 'object' && existing !== null && (existing as { apiVersion?: unknown }).apiVersion !== undefined) return;
  if (existing !== undefined) {
    console.error(new Error('window.nendo is already something else, so Nendo\'s view API cannot be installed. Rename the variable or the element called nendo.'));
    return;
  }

  let port: MessagePort | null = null;
  let context: ViewContext | null = null;
  let nextId = 1;
  let settle: (value: ViewContext) => void = () => undefined;
  let refuse: (error: NendoError) => void = () => undefined;
  const ready = new Promise<ViewContext>((resolve, reject) => { settle = resolve; refuse = reject; });
  // Awaited or not, a refused ready must not surface as an unhandled rejection of its own.
  ready.catch(() => undefined);
  const waiting = new Map<number, Waiting>();
  // Beyond the Workbench's eight in flight a view's calls wait here, so a view that fires
  // a thousand reads is slowed rather than refused.
  const queue: Array<() => void> = [];
  const listeners = new Map<ViewEventName, Set<Listener>>();

  function emit(name: ViewEventName, data: unknown): void {
    for (const listener of listeners.get(name) ?? []) {
      try { (listener as (value: unknown) => void)(data); } catch (error) { console.error(error); }
    }
  }

  function on(name: ViewEventName, listener: (data: never) => void): () => void {
    if (!(viewEventNames as readonly string[]).includes(name))
      throw new NendoError('unknown-event', `${String(name)} is not an event a view can hear.`);
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return () => { listeners.get(name)?.delete(listener); };
  }

  function pump(): void {
    while (waiting.size < extensionLimits.inFlight && queue.length > 0) queue.shift()!();
  }

  function call<T>(method: string, params: unknown = {}, dispatched?: () => void): Promise<T> {
    // Sent as JSON, because JSON is what reaches the host. Checked here as well as at the
    // Workbench, so an honest view learns its request is too large without costing the
    // window a quarter of a megabyte per attempt.
    let body: string | undefined;
    try { body = JSON.stringify(params ?? {}); } catch {
      return Promise.reject(new NendoError('invalid-params', `The parameters of ${method} are not JSON.`));
    }
    if (body === undefined) body = '{}';
    if (utf8Length(body, extensionLimits.requestBytes) > extensionLimits.requestBytes)
      return Promise.reject(new NendoError('too-large', `The parameters of ${method} are larger than 256 KiB.`));
    const payload = JSON.parse(body) as unknown;
    return ready.then(() => new Promise<T>((resolve, reject) => {
      const dispatch = (): void => {
        const id = nextId++;
        waiting.set(id, { resolve: (value) => resolve(value as T), reject });
        port!.postMessage({ t: 'req', id, m: method, p: payload } satisfies PortMessage);
        dispatched?.();
      };
      if (waiting.size < extensionLimits.inFlight) dispatch(); else queue.push(dispatch);
    }));
  }

  function receive(message: PortMessage | null): void {
    if (typeof message !== 'object' || message === null) return;
    if (message.t === 'res') {
      const entry = waiting.get(message.id);
      if (entry === undefined) return;
      waiting.delete(message.id);
      if (message.ok) entry.resolve(message.r);
      else entry.reject(new NendoError(message.e?.code ?? 'failed', message.e?.message ?? 'The request failed.'));
      pump();
    } else if (message.t === 'evt') {
      if (message.n === 'context' && isContext(message.d)) {
        context = message.d;
        applyTheme(context.theme);
      } else if (message.n === 'theme' && context !== null) {
        context = { ...context, theme: message.d as ViewTheme };
        applyTheme(context.theme);
      } else if (message.n === 'place' && context !== null) {
        context = { ...context, place: message.d as Json };
      }
      emit(message.n, message.d);
    } else if (message.t === 'ping') {
      port?.postMessage({ t: 'pong', id: message.id } satisfies PortMessage);
    }
  }

  // Only the window that framed this one can connect it. A second connect is the Workbench
  // having restarted this view's channel: the old port is gone, and whatever was waiting on
  // it will never hear back, so it fails now rather than hanging.
  host.addEventListener('message', (event: MessageEvent) => {
    if (host.parent === host || event.source !== host.parent) return;
    const data = event.data as Partial<ConnectMessage> | null;
    if (typeof data !== 'object' || data === null || data.nendo !== 'connect' || event.ports.length !== 1 ||
        !isContext(data.context)) return;
    for (const entry of waiting.values())
      entry.reject(new NendoError('disconnected', 'The Workbench reconnected this view before Nendo answered. A read can be sent again; a write may have been kept, so read before writing again, or send a batch again under its writeKey.'));
    waiting.clear();
    port?.close();
    port = event.ports[0];
    port.onmessage = (message: MessageEvent) => receive(message.data as PortMessage | null);
    context = data.context;
    applyTheme(context.theme);
    settle(context);
    emit('context', context);
    pump();
  });
  /**
   * An error the view's own code throws and does not catch goes to the Workbench (W-251), which
   * keeps the open file's last few for the agent that wrote the view; the view still sees it
   * in its own console. Only the sentence travels, cut to a bound, never the stack.
   */
  const thrown = (text: unknown): void => {
    if (port === null) return;
    const sentence = typeof text === 'string' && text.length > 0 ? text : 'An error with no message.';
    try { port.postMessage({ t: 'error', text: sentence.slice(0, extensionLimits.errorTextLength) } satisfies PortMessage); } catch { /* the channel is gone */ }
  };
  if (typeof host.addEventListener === 'function') {
    host.addEventListener('error', ((event: { message?: unknown }) => thrown(event.message)) as unknown as EventListener);
    host.addEventListener('unhandledrejection', ((event: { reason?: unknown }) => {
      const reason = event.reason as { message?: unknown } | null | undefined;
      thrown(typeof reason?.message === 'string' ? reason.message : String(event.reason));
    }) as unknown as EventListener);
  }

  // A page opened on its own has no Workbench to connect to: say so, rather than wait forever.
  if (host.parent !== host) host.parent.postMessage({ nendo: 'hello', apiVersion } satisfies HelloMessage, '*');
  else refuse(new NendoError('not-framed', 'This page is a Nendo view. It runs inside Nendo, on a screen or a record page that shows it.'));

  /**
   * Keys (W-090). A key pressed in a cross-origin frame never reaches the Workbench, so Nendo's
   * own keys would do nothing while a view had focus. Pressed here, one of Nendo's is handed to
   * the Workbench before the view sees it, as it is Nendo's; Alt and an arrow are not taken
   * from a field, where they move within it, as the Workbench leaves them there too. A key the
   * view's toolbar declares goes the same way once the view has had its chance: a view that
   * handles the key itself calls preventDefault, and a person typing in a field keeps it.
   */
  if (typeof host.addEventListener === 'function') {
    host.addEventListener('keydown', ((event: KeyEvent) => {
      if (port === null || event.repeat === true || event.isComposing === true) return;
      const keys = chordOf(event);
      if (keys === null || !hostKeys.includes(keys)) return;
      if (keys.startsWith('Alt+Arrow') && typing(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      port.postMessage({ t: 'key', keys } satisfies PortMessage);
    }) as unknown as EventListener, true);
    host.addEventListener('keydown', ((event: KeyEvent) => {
      if (port === null || event.repeat === true || event.isComposing === true || event.defaultPrevented === true) return;
      const keys = chordOf(event);
      if (keys === null || !declared.has(keys) || typing(event.target)) return;
      event.preventDefault();
      port.postMessage({ t: 'key', keys } satisfies PortMessage);
    }) as unknown as EventListener);
  }

  /** Every node of a tree window, depth-first, read again from the top if the file changes between pages. */
  const treeAll = (query: Query, options: { max?: number } = {}): Promise<ViewTreeNode[]> =>
    readAll<ViewTreeNode>(call, 'records.tree', query, options);

  const queryAll = (query: Query, options: { max?: number } = {}): Promise<ViewRecord[]> =>
    readAll<ViewRecord>(call, 'records.query', query, options);

  /** The view's authored filters for one record type, with `today`, `now` and the periods resolved as it reads. */
  function authoredFilters(view: ViewContext, entityId: string | null): Array<{ fieldId: string; operator: string; value?: Json }> {
    const at = new Date();
    return view.bindings.filters.filter((filter) => filter.entityId === entityId).map((filter) =>
      filter.operator === 'isNull' || filter.operator === 'isNotNull'
        ? { fieldId: filter.fieldId, operator: filter.operator }
        : isPeriod(filter.valueKind)
          ? { fieldId: filter.fieldId, ...resolvePeriodClause(filter.operator, filter.valueKind, at, filter.storageKind) }
          : { fieldId: filter.fieldId, operator: filter.operator, value: resolveClauseValue(filter.valueKind, filter.value, at, filter.storageKind) as Json });
  }

  /** The records the view is about: its record type under its filters, or the page's one record. */
  async function loadRecords(): Promise<ViewRecord[]> {
    await ready;
    const view = context!;
    if (view.entityId === null) return [];
    if (view.recordId !== null) {
      const record = await call<ViewRecord | null>('records.get', { entityId: view.entityId, recordId: view.recordId });
      return record === null ? [] : [record];
    }
    return queryAll({ entityId: view.entityId, filters: authoredFilters(view, view.entityId) });
  }

  /**
   * The view's records as nodes and its link records as edges between them. A link whose
   * source or target is not among the nodes (filtered out, or pointing nowhere) is left out
   * and counted, so a view can say how much it is not drawing.
   */
  async function loadGraph(): Promise<ViewGraph> {
    await ready;
    const view = context!;
    const bindings = view.bindings;
    const edgeEntityId = bindings.edgeEntityId;
    const [schema, nodeRecords, edgeRecords] = await Promise.all([
      call<SchemaDescription>('schema.describe'),
      loadRecords(),
      edgeEntityId === null || view.recordId !== null
        ? Promise.resolve<ViewRecord[]>([])
        : queryAll({ entityId: edgeEntityId, filters: authoredFilters(view, edgeEntityId) }),
    ]);
    return graphOf(view, schema, nodeRecords, edgeRecords);
  }

  // State writes wait their turn in a lane of their own, in the order they were made, one every
  // stateWriteSpacingMs after the last one actually reached the Workbench. Spaced when they left
  // this lane, they could still wait together behind eight reads in flight and reach the
  // broker in the same millisecond, where the third was refused as busy (WXS-09).
  //
  // A key written again while its write waits replaces the value, and every caller of that key
  // hears the one answer, but only when neither write is conditional. A write with an
  // expectedVersion is sent alone and answered alone: merged with a later write, its condition
  // was dropped and its caller told the other write's answer (WXS-03).
  const stateQueue: Array<{ id: string; conditional: boolean; method: string; params: Record<string, unknown>; waiters: Waiting[] }> = [];
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  let stateSending = false;
  let stateSentAt = -Infinity;
  function queueState(method: string, params: Record<string, unknown>): Promise<StateEntry | null> {
    const id = `${String(params.scope ?? 'view')}\u0000${String(params.key)}`;
    const conditional = params.expectedVersion !== undefined && params.expectedVersion !== null;
    return new Promise((resolve, reject) => {
      const waiter: Waiting = { resolve: resolve as (value: unknown) => void, reject };
      const last = stateQueue.findLast((entry) => entry.id === id);
      if (last !== undefined && !last.conditional && !conditional) { last.method = method; last.params = params; last.waiters.push(waiter); }
      else stateQueue.push({ id, conditional, method, params, waiters: [waiter] });
      pumpState();
    });
  }
  function pumpState(): void {
    if (stateTimer !== null || stateSending || stateQueue.length === 0) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      const entry = stateQueue.shift();
      if (entry === undefined) return;
      stateSending = true;
      let sent = false;
      const reached = (): void => {
        if (sent) return;
        sent = true;
        stateSentAt = Date.now();
        stateSending = false;
        pumpState();
      };
      call(entry.method, entry.params, reached).then(
        (answer) => { for (const waiter of entry.waiters) waiter.resolve(answer); },
        (error: unknown) => { for (const waiter of entry.waiters) waiter.reject(error); }).finally(reached);
    }, Math.max(0, stateSentAt + extensionLimits.stateWriteSpacingMs - Date.now()));
  }

  /**
   * The view's controls in Nendo's own chrome (W-090). A declaration replaces the last, so one
   * made while another waits its turn replaces it, and every caller hears the answer to the
   * one sent: at most one every toolbarSpacingMs, so a view that declares its zoom on every
   * wheel tick costs ten redraws of the strip a second, not sixty.
   */
  let toolbarWaiting: { params: Record<string, unknown>; keys: Set<string>; waiters: Waiting[] } | null = null;
  let toolbarTimer: ReturnType<typeof setTimeout> | null = null;
  let toolbarSentAt = -Infinity;
  /** The keys the toolbar Nendo last accepted declares: pressed here, they go to the Workbench. */
  let declared = new Set<string>();

  function sendToolbar(): void {
    if (toolbarTimer !== null || toolbarWaiting === null) return;
    toolbarTimer = setTimeout(() => {
      toolbarTimer = null;
      const entry = toolbarWaiting;
      toolbarWaiting = null;
      if (entry === null) return;
      toolbarSentAt = Date.now();
      call('ui.setToolbar', entry.params).then(
        (answer) => { declared = entry.keys; for (const waiter of entry.waiters) waiter.resolve(answer); },
        (error: unknown) => { for (const waiter of entry.waiters) waiter.reject(error); });
      sendToolbar();
    }, Math.max(0, toolbarSentAt + extensionLimits.toolbarSpacingMs - Date.now()));
  }

  function setToolbar(toolbar: { items?: unknown[]; add?: string | null } | unknown[]): Promise<null> {
    const spec = Array.isArray(toolbar) ? { items: toolbar } : toolbar ?? {};
    const params = { items: (spec as { items?: unknown }).items ?? [], add: (spec as { add?: unknown }).add ?? null };
    return new Promise((resolve, reject) => {
      const waiter: Waiting = { resolve: resolve as (value: unknown) => void, reject };
      if (toolbarWaiting === null) toolbarWaiting = { params, keys: keysOf(params.items), waiters: [waiter] };
      else { toolbarWaiting.params = params; toolbarWaiting.keys = keysOf(params.items); toolbarWaiting.waiters.push(waiter); }
      sendToolbar();
    });
  }

  /**
   * One of Nendo's menus at a point in this view: the person's pick, as `{id, value}`, or null
   * when they dismiss it. `at` is a point in the view's own pixels, or the mouse event itself.
   */
  function showMenu(items: unknown[], at: MenuPoint): Promise<{ id: string; value: string | boolean | null } | null> {
    const point = 'clientX' in at ? { x: at.clientX, y: at.clientY } : { x: at.x, y: at.y };
    return call('ui.showMenu', { items, x: point.x, y: point.y });
  }

  const nendo = Object.freeze({
    apiVersion,
    /** Resolves with the view's context once the Workbench has connected it. */
    ready,
    get context(): ViewContext | null { return context; },
    has: (name: string): boolean => context?.methods.includes(name) ?? false,
    on,
    NendoError,
    schema: Object.freeze({
      describe: (): Promise<SchemaDescription> => call<SchemaDescription>('schema.describe'),
    }),
    /** Pictures (ADR-0031): a media field's address described, an embedded picture read, a picture embedded. */
    media: Object.freeze({
      describe: (address: string): Promise<unknown> => call('media.describe', { address }),
      urlFor: async (address: string): Promise<string | null> =>
        ((await call<{ url?: string | null }>('media.describe', { address })).url ?? null),
      read: async (address: string): Promise<Blob> => {
        const answer = await call<{ bytes: ArrayBuffer; mediaType: string }>('media.read', { address });
        return new Blob([answer.bytes], { type: answer.mediaType });
      },
      put: async (data: Blob | ArrayBuffer | Uint8Array, options: { name?: string; mediaType?: string; record?: { entityId: string; recordId: string; version: number }; fieldId?: string } = {}): Promise<{ address: string | null }> => {
        const whole = typeof Blob !== 'undefined' && data instanceof Blob ? await data.arrayBuffer() : data as ArrayBuffer | Uint8Array;
        const bytes = whole instanceof Uint8Array ? whole : new Uint8Array(whole);
        const name = options.name ?? (typeof File !== 'undefined' && data instanceof File ? data.name : undefined);
        const target = options.record === undefined || options.fieldId === undefined ? {}
          : { entityId: options.record.entityId, recordId: options.record.recordId, version: options.record.version, fieldId: options.fieldId };
        // A request crosses as JSON, which has no bytes and holds at most 256 KiB, so the picture
        // goes as base64 in parts the broker stages in the package's name, and a last call commits
        // them. Until 2026-10-18 the bytes went as they were and arrived as {}, refused every time.
        const uploadKey = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID() : `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        for (let offset = 0; offset < bytes.length; offset += extensionLimits.mediaPartBytes) {
          let text = '';
          for (const byte of bytes.subarray(offset, offset + extensionLimits.mediaPartBytes)) text += String.fromCharCode(byte);
          await call('media.put', { uploadKey, offset, base64: btoa(text) });
        }
        return call<{ address: string | null }>('media.put', { uploadKey, name, mediaType: options.mediaType, ...target });
      },
    }),
    records: Object.freeze({
      query: (query: Query): Promise<ViewPage> => call<ViewPage>('records.query', query),
      get: (entityId: string, recordId: string): Promise<ViewRecord | null> => call<ViewRecord | null>('records.get', { entityId, recordId }),
      count: (query: Query): Promise<unknown> => call('records.count', query),
      aggregate: (query: Query): Promise<unknown> => call('records.aggregate', query),
      groupAggregate: (query: Query): Promise<unknown> => call('records.groupAggregate', query),
      bucketAggregate: (query: Query): Promise<unknown> => call('records.bucketAggregate', query),
      cellAggregate: (query: Query): Promise<unknown> => call('records.cellAggregate', query),
      queryAll,
      /**
       * A window of a record type's declared hierarchy, depth-first (ADR-0019): { entityId,
       * rootRecordId?, depth? (1 to 32, default 1), limit?, cursor? }. Each node carries its record,
       * its parent, its depth below the root and its child count. treeAll reads every page.
       */
      tree: (query: Query): Promise<ViewTreePage> => call<ViewTreePage>('records.tree', query),
      /**
       * A full-text search over the file's text fields, best match first (ADR-0028): what the person
       * typed, and { entityIds?, fieldIds?, limit? (1 to 100, 20 by default), cursor? }. Words are all
       * required and may sit in different fields; "a phrase" in quotes, -word to leave records out, and
       * the last word also matches as a prefix. Refused with search-index-missing until the file has
       * an index; Nendo builds one when the person asks.
       */
      search: (text: string, options: Query = {}): Promise<ViewSearchPage> =>
        call<ViewSearchPage>('records.search', { ...options, text }),
      treeAll,
      /**
       * Writes, as the person's own edit makes them (ADR-0013 Phase 3). Each is checked against the
       * record's version and refused if somebody changed it since; each is in History under this
       * view's package, and undone there. Each answers the record as it now stands. A write that
       * sets a reference passes the target's version in targetVersions. create's third argument is
       * { recordId, targetVersions }, or the record ID alone.
       */
      create: (entityId: string, values: WriteValues, options?: string | CreateOptions): Promise<ViewRecord | null> => {
        const { recordId, targetVersions } = typeof options === 'string' ? { recordId: options, targetVersions: undefined } : options ?? {};
        return call<ViewRecord | null>('records.create', {
          entityId, values, ...(recordId === undefined ? {} : { recordId }), ...(targetVersions === undefined ? {} : { targetVersions }),
        });
      },
      update: (record: RecordAt, values: WriteValues, options?: UpdateOptions): Promise<ViewRecord | null> =>
        call<ViewRecord | null>('records.update', {
          entityId: record.entityId, recordId: record.recordId, version: record.version, values,
          ...(options?.targetVersions === undefined ? {} : { targetVersions: options.targetVersions }),
        }),
      delete: (record: RecordAt): Promise<null> =>
        call<null>('records.delete', { entityId: record.entityId, recordId: record.recordId, version: record.version }),
      /**
       * Several writes as one revision (W-102): all commit or none do, and History shows one
       * entry, named by options.label. A record appears at most once. A reference to a record
       * created or updated earlier in the batch needs no target version: Nendo checks it against
       * the version that write leaves. Answers each record's new version, in the order written,
       * and null for a deleted one. options.writeKey (1 to 64 letters, digits, - or _) names the
       * batch: sent again with the same key and the same writes, after a timeout or a reconnect
       * left its outcome unknown, it is kept once and answers as it did; with other writes it is
       * refused. Without a key a batch sent again is a new batch. options.offerUndo asks Nendo to
       * offer Undo in its own notice (W-250), which stays while the person moves on, the record
       * the view opens next included, until the next notice; the answer says undoOffered.
       */
      batch: (writes: BatchWrite[], options?: BatchOptions): Promise<BatchAnswer> =>
        call<BatchAnswer>('records.batch', {
          writes,
          ...(options?.label === undefined ? {} : { label: options.label }),
          ...(options?.writeKey === undefined ? {} : { writeKey: options.writeKey }),
          ...(options?.offerUndo === undefined ? {} : { offerUndo: options.offerUndo }),
        }),
      /**
       * Undoes a revision this view wrote since it opened, named by the batch's answer, as a new
       * revision (ADR-0023): updates put back, deletes restored, creates deleted. A record changed,
       * deleted or newly pointed at since refuses the whole undo, and nothing is written. History
       * names it "Undo" and the batch's label, or options.label. Answers like a batch; keep its
       * revision for the redo. Ask nendo.has('records.undo') first.
       */
      undo: (revision: string, options?: UndoOptions): Promise<BatchAnswer> =>
        call<BatchAnswer>('records.undo', { revision, ...(options?.label === undefined ? {} : { label: options.label }) }),
      /** Redoes an undo this view made, by the undo's revision, the same way. Undo the redo's revision to undo again. */
      redo: (revision: string, options?: UndoOptions): Promise<BatchAnswer> =>
        call<BatchAnswer>('records.redo', { revision, ...(options?.label === undefined ? {} : { label: options.label }) }),
      /**
       * Moves a record in its record type's declared tree (ADR-0019): under parentRecordId, with the
       * parent's version as the view read it, or to the top level with null; before the sibling
       * beforeRecordId, or last. The subtree moves with it. The Engine refuses a loop and a tree
       * deeper than 32 levels, and renumbers the siblings when no gap is left, in one revision.
       * Answers the record as it now stands.
       */
      move: (record: RecordAt, to: MoveTarget): Promise<ViewRecord | null> =>
        call<ViewRecord | null>('records.move', {
          entityId: record.entityId, recordId: record.recordId, version: record.version,
          parentRecordId: to.parentRecordId ?? null,
          ...(to.parentRecordId ? { parentVersion: to.parentVersion } : {}),
          ...(to.beforeRecordId ? { beforeRecordId: to.beforeRecordId } : {}),
        }),
    }),
    commands: Object.freeze({
      /** Runs a record command the file defines (schema.describe lists them), on the record at the version given. */
      run: (commandId: string, record: RecordAt): Promise<ViewRecord | null> =>
        call<ViewRecord | null>('commands.run', { commandId, entityId: record.entityId, recordId: record.recordId, version: record.version }),
    }),
    proposals: Object.freeze({
      /**
       * Prepares a definition change in this view's package's name and opens it in Nendo's review
       * (ADR-0013 Phase 3). The person accepts or rejects it; a view never can. One proposal of a
       * package waits at a time. Answers { proposalId, title, state, diagnostics, opened }.
       */
      prepare: (title: string, operations: unknown[]): Promise<ProposalAnswer> => call<ProposalAnswer>('proposals.prepare', { title, operations }),
      /** A proposal this package prepared: its state is previewable, active, rejected, stale, invalid or failed. */
      get: (proposalId: string): Promise<ProposalAnswer> => call<ProposalAnswer>('proposals.get', { proposalId }),
      /** Opens the review of a proposal this package prepared again. */
      open: (proposalId: string): Promise<ProposalAnswer> => call<ProposalAnswer>('proposals.open', { proposalId }),
    }),
    state: Object.freeze({
      /**
       * What this view keeps with the file (ADR-0013 Phase 3): a copy of the file carries it,
       * History names the package on each change, and the person can undo one there. Values
       * are JSON of at most 64 KiB. `{ scope: 'package' }` shares a value across the package's
       * views. Writes to one key are coalesced and sent at most twice a second; a write with an
       * expectedVersion is never coalesced, and is answered on its own.
       */
      get: (key: string, options: StateOptions = {}): Promise<StateEntry | null> => call<StateEntry | null>('state.get', { key, ...options }),
      set: (key: string, value: unknown, options: StateOptions & { expectedVersion?: number } = {}): Promise<StateEntry | null> =>
        queueState('state.set', { key, value, ...options }),
      delete: (key: string, options: StateOptions & { expectedVersion?: number } = {}): Promise<null> =>
        queueState('state.delete', { key, ...options }) as Promise<null>,
      keys: (options: StateOptions = {}): Promise<Array<{ key: string; version: number }>> => call('state.keys', { ...options }),
    }),
    changes: Object.freeze({
      /** Hears the file's change sequence each time anything commits, at most four times a second. */
      subscribe: (listener: (changeSequence: number) => void): (() => void) => on('changes', listener as Listener),
    }),
    ui: Object.freeze({
      openRecord: (entityId: string, recordId: string): Promise<unknown> => call('ui.openRecord', { entityId, recordId }),
      openScreen: (surfaceId: string): Promise<unknown> => call('ui.openScreen', { surfaceId }),
      openStudio: (entityId?: string): Promise<unknown> => call('ui.openStudio', { entityId: entityId ?? null }),
      toast: (text: string): Promise<unknown> => call('ui.toast', { text }),
      setHeight: (pixels: number): Promise<unknown> => call('ui.setHeight', { pixels }),
      /**
       * The view's controls, drawn by Nendo in its own toolbar, menus, Ctrl K and keys: { items,
       * add }, or the list of items alone. Each call replaces the last; an empty list removes
       * them. A press arrives as the event `command`. `add` names the command Nendo's own Add
       * button runs on this view's screen. Ask nendo.has('ui.setToolbar') first: an older Nendo
       * leaves the view to draw its own.
       */
      setToolbar,
      /** One of Nendo's menus at a point in the view, or at a mouse event: the pick as { id, value }, or null. */
      showMenu,
      /**
       * Where this view is, for Back and Forward (W-127): JSON of at most 4 KiB, and a label
       * the Back button shows. A new place is a step; `{ replace: true }` corrects the step the
       * person is on, for a selection or the place the view starts at. Declaring the place it
       * already has does nothing. Back and Forward hand a place back as the event `place`, and
       * a view that starts again finds it in `nendo.context.place`. Ask nendo.has('ui.setPlace')
       * first.
       */
      setPlace: (place: unknown, options: { label?: string; replace?: boolean } = {}): Promise<null> =>
        call<null>('ui.setPlace', { place: place ?? null, label: options.label ?? null, replace: options.replace === true }),
      get theme(): ViewTheme | null { return context?.theme ?? null; },
    }),
    view: Object.freeze({ loadRecords, loadGraph }),
  });
  Object.defineProperty(host, 'nendo', { value: nendo, enumerable: true });
}

install(window as Window & { nendo?: unknown });
