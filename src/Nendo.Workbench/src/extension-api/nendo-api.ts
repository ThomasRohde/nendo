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
import { resolveClauseValue } from '../record-window';
import {
  apiVersion, extensionLimits, utf8Length,
  type ConnectMessage, type HelloMessage, type Json, type PortMessage, type SchemaDescription, type SchemaField,
  type ViewContext, type ViewEventName, type ViewGraph, type ViewPage, type ViewRecord, type ViewTheme,
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

function install(host: Window & { nendo?: unknown }): void {
  // Taken twice, the second copy would answer a second connect and strand the first's calls.
  if (host.nendo !== undefined) return;

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
    if (name !== 'context' && name !== 'theme' && name !== 'changes')
      throw new NendoError('unknown-event', `${String(name)} is not an event a view can hear.`);
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return () => { listeners.get(name)?.delete(listener); };
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

  function pump(): void {
    while (waiting.size < extensionLimits.inFlight && queue.length > 0) queue.shift()!();
  }

  function call<T>(method: string, params: unknown = {}): Promise<T> {
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
      entry.reject(new NendoError('disconnected', 'The Workbench reconnected this view; send the request again.'));
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
  // A page opened on its own has no Workbench to connect to: say so, rather than wait forever.
  if (host.parent !== host) host.parent.postMessage({ nendo: 'hello', apiVersion } satisfies HelloMessage, '*');
  else refuse(new NendoError('not-framed', 'This page is a Nendo view. It runs inside Nendo, on a screen or a record page that shows it.'));

  async function queryAll(query: Query, options: { max?: number } = {}): Promise<ViewRecord[]> {
    const max = Math.max(1, Math.floor(options.max ?? 10_000));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const records: ViewRecord[] = [];
      let cursor: string | null = null;
      try {
        do {
          const page: ViewPage = await call<ViewPage>('records.query', { ...query, cursor, limit: extensionLimits.maximumPageLimit });
          records.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null && records.length < max);
        return records.slice(0, max);
      } catch (error) {
        // A file that changes between pages ends the continuation; read again from the top.
        if (!(error instanceof NendoError) || (error.code !== 'stale-cursor' && error.code !== 'invalid-cursor')) throw error;
      }
    }
    throw new NendoError('stale-cursor', 'The file kept changing while the view read it. Read again when it settles.');
  }

  /** The view's authored filters for one record type, with `today` and `now` resolved as it reads. */
  function authoredFilters(view: ViewContext, entityId: string | null): Array<{ fieldId: string; operator: string; value?: Json }> {
    const at = new Date();
    return view.bindings.filters.filter((filter) => filter.entityId === entityId).map((filter) =>
      filter.operator === 'isNull' || filter.operator === 'isNotNull'
        ? { fieldId: filter.fieldId, operator: filter.operator }
        : { fieldId: filter.fieldId, operator: filter.operator, value: resolveClauseValue(filter.valueKind, filter.value, at) as Json });
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
       * Writes, as the person's own edit makes them (ADR-0013 Phase 3). Each is checked against the
       * record's version and refused if somebody changed it since; each is in History under this
       * view's package, and undone there. Each answers the record as it now stands.
       */
      create: (entityId: string, values: WriteValues, recordId?: string): Promise<ViewRecord | null> =>
        call<ViewRecord | null>('records.create', { entityId, values, ...(recordId === undefined ? {} : { recordId }) }),
      update: (record: RecordAt, values: WriteValues): Promise<ViewRecord | null> =>
        call<ViewRecord | null>('records.update', { entityId: record.entityId, recordId: record.recordId, version: record.version, values }),
      delete: (record: RecordAt): Promise<null> =>
        call<null>('records.delete', { entityId: record.entityId, recordId: record.recordId, version: record.version }),
    }),
    commands: Object.freeze({
      /** Runs a record command the file defines (schema.describe lists them), on the record at the version given. */
      run: (commandId: string, record: RecordAt): Promise<ViewRecord | null> =>
        call<ViewRecord | null>('commands.run', { commandId, entityId: record.entityId, recordId: record.recordId, version: record.version }),
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
      get theme(): ViewTheme | null { return context?.theme ?? null; },
    }),
    view: Object.freeze({ loadRecords, loadGraph }),
  });
  Object.defineProperty(host, 'nendo', { value: nendo, enumerable: true });
}

install(window as Window & { nendo?: unknown });
