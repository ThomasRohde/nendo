import { plainJson, plainPage, plainRecord, plainTreePage } from './extension-model';
import { WorkbenchHostError, type RecordSnapshot } from './host-types';
import {
  apiVersion, extensionLimits, hostKeys, utf8Length,
  type ConnectMessage, type Json, type PortMessage, type SchemaDescription, type ViewCommand, type ViewContext, type ViewTheme,
} from './extension-api/protocol';
import { declaredKeys, readMenu, readToolbar, type CommandValue, type ViewMenuRequest, type ViewToolbar } from './view-toolbar-model';

/**
 * The broker between custom views and the Workbench (ADR-0013).
 *
 * A view is a cross-origin frame. Its api.js says hello to the window that framed it; the
 * broker answers only a frame it mounted itself, and only from that frame's own origin, with
 * one end of a fresh MessageChannel. Every request on that port is checked against the
 * closed method table below and becomes one of the Workbench's own typed reads, or a thing
 * the Workbench does for the person (open a record, show a sentence). There is no other way
 * in: nothing a view sends is ever used as a method name, a host payload or an identity.
 *
 * This module is the protocol and nothing else. Which frames exist, how a view is shown and
 * how the Workbench navigates are handed in by view-frames.ts, so that
 * scripts/extension-broker.test.mjs can drive the real broker without a window.
 */

/** A frame the broker may connect: its mount key, the origin it was mounted at, its window. */
export interface BrokerMount {
  readonly key: string;
  readonly origin: string;
  /** The mounted iframe's contentWindow, or null while there is no frame. */
  frameWindow(): unknown;
}

/** The things a view may ask the Workbench to do for the person. */
export interface BrokerUi {
  openRecord(mount: BrokerMount, target: { entityId: string; recordId: string }): Promise<unknown>;
  openScreen(mount: BrokerMount, target: { surfaceId: string }): Promise<unknown>;
  openStudio(mount: BrokerMount, target: { entityId: string | null }): Promise<unknown>;
  toast(mount: BrokerMount, text: string): void;
  /** Sets the mount's height and answers the height it now has. */
  setHeight(mount: BrokerMount, pixels: number): number;
  /**
   * Opens a proposal the view's package prepared in the Workbench's own review (ADR-0013
   * Phase 3). Answers whether it opened: it does not while a record page holds unsaved typing
   * or another action runs, and the proposal then waits for the view to ask again.
   */
  openProposal(mount: BrokerMount, preview: unknown): { opened: boolean };
  /**
   * Draw the view's controls in Nendo's own chrome, or take them away with null (ADR-0013,
   * 2026-09-28; W-090). The declaration has been checked and rebuilt; nothing in it is markup.
   */
  setToolbar(mount: BrokerMount, toolbar: ViewToolbar | null): void;
  /** Draw one of Nendo's menus at a point in the view's frame; answers the item picked, or null. */
  showMenu(mount: BrokerMount, menu: ViewMenuRequest): Promise<{ id: string; value: CommandValue } | null>;
  /**
   * A key pressed inside the view that is one of Nendo's own, or one the view declared: run
   * it as if it had been pressed in the Workbench.
   */
  key(mount: BrokerMount, keys: string): void;
  /**
   * The view says where it is, for Back and Forward (W-127): a new step, or with `replace` a
   * correction of the step the person is on. Answers whether anything changed.
   */
  setPlace(mount: BrokerMount, place: { value: Json; label: string | null; replace: boolean }): boolean;
}

export interface BrokerDeps {
  /** The Workbench's own host bridge. */
  request(method: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Every mount that has a frame now. */
  mounts(): Iterable<BrokerMount>;
  /** Whether views may run now; the host answers 403 on every view origin when they may not. */
  running(): boolean;
  context(mount: BrokerMount): ViewContext;
  describe(): SchemaDescription;
  ui: BrokerUi;
  /** A view stopped answering its pings, or answered again. */
  responsive?(mount: BrokerMount, responsive: boolean): void;
  /** A view connected, or connected again after reloading itself. */
  connected?(mount: BrokerMount): void;
  now(): number;
  later(callback: () => void, milliseconds: number): void;
}

type Params = Record<string, unknown>;

interface MethodCall {
  params: Params;
  mount: BrokerMount;
  deps: BrokerDeps;
  connection: {
    toastAt: number; stateWrites: number[]; toolbars: number[]; menus: number[]; keys: Set<string>;
    places: number[]; placeJson: string; contextJson: string;
  };
}

/** At most `limit` of something in any second: the times it happened, pruned, then this one added. */
function withinRate(times: number[], now: number, limit: number, refusal: string): void {
  const recent = times.filter((at) => at > now - 1_000);
  times.length = 0;
  times.push(...recent);
  if (times.length >= limit) throw new WorkbenchHostError('busy', refusal);
  times.push(now);
}

interface MethodEntry {
  /** The typed read or write this method becomes, or null for one the Workbench answers itself. */
  readonly host: string | null;
  /** Whether it changes the file, and so goes to the host as the view's package (ADR-0013 Phase 3). */
  readonly writes?: boolean;
  readonly run: (call: MethodCall) => unknown;
}

function invalid(message: string): WorkbenchHostError {
  return new WorkbenchHostError('invalid-params', message);
}

function textParam(params: Params, key: string, maximum = 256): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    throw invalid(`${key} must be text of 1 to ${maximum} characters.`);
  return value;
}

function optionalText(params: Params, key: string, maximum = 256): string | undefined {
  return params[key] === undefined || params[key] === null ? undefined : textParam(params, key, maximum);
}

function optionalBoolean(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${key} must be true or false.`);
  return value;
}

/** How many levels a tree read goes below its root: 1 unless the view says, and never past the host's bound. */
function treeDepth(params: Params): number {
  const value = params.depth;
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 32)
    throw invalid('depth must be a whole number from 1 to 32.');
  return value;
}

function pageLimit(params: Params): number {
  const value = params.limit;
  if (value === undefined || value === null) return extensionLimits.defaultPageLimit;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > extensionLimits.maximumPageLimit)
    throw invalid(`limit must be a whole number from 1 to ${extensionLimits.maximumPageLimit}.`);
  return value;
}

/** A query's clauses, rebuilt key by key: nothing a view adds to a clause reaches the host. */
function filterParams(params: Params): Params[] {
  const value = params.filters;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) throw invalid('filters must be a list of at most 64 clauses.');
  return value.map((clause: unknown) => {
    if (typeof clause !== 'object' || clause === null || Array.isArray(clause))
      throw invalid('Each filter is an object with fieldId, operator and, unless it tests for a value, value.');
    const source = clause as Params;
    const rebuilt: Params = { fieldId: textParam(source, 'fieldId'), operator: textParam(source, 'operator', 32) };
    if (source.value !== undefined) rebuilt.value = source.value;
    return rebuilt;
  });
}

/** A read the host answers. The payload is built key by key from the view's parameters. */
function read(host: string, payload: (params: Params) => Params, answer: (result: unknown) => unknown = plainJson): MethodEntry {
  return { host, run: async ({ params, deps }) => answer(await deps.request(host, payload(params))) };
}

function local(run: (call: MethodCall) => unknown): MethodEntry {
  return { host: null, run };
}

function versionParam(params: Params, key = 'version'): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw invalid(`${key} must be the record's version, a whole number from 1: read it from the record.`);
  return value;
}

/**
 * The values a view writes, rebuilt field by field. A value is null, text, true or false, a
 * number, or `{ $nendoNumber: '…' }` for a decimal whose digits a JavaScript number would not
 * keep, the envelope every exact number crosses the bridge in. Nothing else is passed on.
 */
function valuesParam(params: Params): Params {
  const value = params.values;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('values must be an object of field IDs to values.');
  const entries = Object.entries(value as Params);
  if (entries.length === 0 || entries.length > 64) throw invalid('values must name 1 to 64 fields.');
  const rebuilt = new Map<string, unknown>();
  for (const [fieldId, item] of entries) {
    if (fieldId.length === 0 || fieldId.length > 256) throw invalid('Each field ID is text of 1 to 256 characters.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') rebuilt.set(fieldId, item);
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalid(`${fieldId} must be a finite number.`);
      rebuilt.set(fieldId, { $nendoNumber: String(item) });
    } else if (typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1 &&
      typeof (item as Params).$nendoNumber === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test((item as Params).$nendoNumber as string) &&
      ((item as Params).$nendoNumber as string).length <= 128) {
      rebuilt.set(fieldId, { $nendoNumber: (item as Params).$nendoNumber });
    } else throw invalid(`${fieldId} must be null, text, true or false, a number, or { $nendoNumber: '…' }.`);
  }
  return Object.fromEntries(rebuilt);
}

/**
 * The version of each reference target a write assigns, by field ID: the host checks that the
 * record a reference now points at is still the one the view read, as it does for the person's
 * own reference picker, and refuses a non-null reference without one (target-version-required).
 * Rebuilt key by key; a field it names must be one the write assigns. Absent, nothing is sent.
 */
function targetVersionsParam(params: Params, values: Params): { expectedTargetVersions?: Record<string, number> } {
  const value = params.targetVersions;
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('targetVersions must be an object of reference field IDs to the target record’s version.');
  const entries = Object.entries(value as Params);
  if (entries.length > 64) throw invalid('targetVersions names at most 64 fields.');
  const rebuilt = new Map<string, number>();
  for (const [fieldId, version] of entries) {
    if (!Object.hasOwn(values, fieldId)) throw invalid(`targetVersions names ${fieldId.slice(0, 256)}, which this write does not assign.`);
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
      throw invalid(`targetVersions.${fieldId} must be the target record’s version, a whole number from 1: read it from that record.`);
    rebuilt.set(fieldId, version);
  }
  return entries.length === 0 ? {} : { expectedTargetVersions: Object.fromEntries(rebuilt) };
}

/**
 * Where a move puts a record in its declared tree (ADR-0019): under a parent, with the version
 * of the parent the view read, or at the top level with neither; and before a sibling, or last.
 */
function moveTarget(params: Params): Params {
  const parentRecordId = optionalText(params, 'parentRecordId') ?? null;
  const target: Params = { parentRecordId, beforeRecordId: optionalText(params, 'beforeRecordId') ?? null };
  if (parentRecordId !== null) target.expectedParentVersion = versionParam(params, 'parentVersion');
  else if (params.parentVersion !== undefined && params.parentVersion !== null)
    throw invalid('parentVersion goes with parentRecordId; a move to the top level names neither.');
  return target;
}

/** A write's values and, when it assigns references, the version of each target it read. */
function assignedValues(params: Params): Params {
  const values = valuesParam(params);
  return { values, ...targetVersionsParam(params, values) };
}

/**
 * A write, as the person's own edit makes it, attributed to the view's package.
 *
 * The actor is the mount's package, from the view definition the Workbench mounted, and never
 * anything the view sent: a view cannot write as the person or as another package. The host
 * admits that actor on these methods alone and refuses it elsewhere (actor-not-allowed), and
 * History records the write under it. Each call carries a fresh idempotency key, so a
 * retried request is never applied twice. The answer is the record as it now stands, read
 * back, so the view has the version its next write needs; a deleted record answers null.
 */
function write(host: string, payload: (params: Params) => Params & { entityId: string; recordId?: string }, readBack = true): MethodEntry {
  return {
    host,
    writes: true,
    run: async ({ params, mount, deps }) => {
      const context = deps.context(mount);
      if (context.readOnly) throw new WorkbenchHostError('read-only', 'This file is open read-only, so a view cannot change it.');
      const body = payload(params);
      await deps.request(host, { ...body, idempotencyKey: `view-${crypto.randomUUID()}`, actor: `extension:${context.packageId}` });
      if (!readBack || body.recordId === undefined) return null;
      const page = await deps.request('data.queryRecords', { entityId: body.entityId, recordId: body.recordId, limit: 1 }) as { items?: RecordSnapshot[] } | null;
      const item = page?.items?.[0];
      return item === undefined ? null : plainRecord(item);
    },
  };
}

/**
 * The revisions each frame was answered in this visit: its batches, undos and redos. They are
 * the only ones it may ask to undo or redo (ADR-0023), so a view never reverses a person's
 * edit, another view's or one it made before it was mounted again.
 */
const ownRevisions = new WeakMap<BrokerMount, Set<string>>();

/** A batch's, an undo's or a redo's answer: each record's version, and the revision it wrote. */
function writtenRecords(mount: BrokerMount, result: unknown): Params {
  const view = result as { mutation?: { revisionId?: unknown }; records?: { entityId?: unknown; recordId?: unknown; recordVersion?: unknown }[] } | null;
  const revision = typeof view?.mutation?.revisionId === 'string' ? view.mutation.revisionId : null;
  if (revision !== null) {
    const own = ownRevisions.get(mount) ?? new Set<string>();
    own.add(revision);
    ownRevisions.set(mount, own);
  }
  return {
    records: (view?.records ?? []).map((record) => ({
      entityId: String(record.entityId ?? ''), recordId: String(record.recordId ?? ''),
      version: typeof record.recordVersion === 'number' ? record.recordVersion : null,
    })),
    revision,
  };
}

/**
 * Undo or redo of a revision this frame wrote (ADR-0023): the host compensates it in the
 * package's name, version-checked, and refuses the whole step when a record changed since.
 */
function undoWrites(redo: boolean): MethodEntry {
  return {
    host: 'data.undoRecordWrites',
    writes: true,
    run: async ({ params, mount, deps }) => {
      const context = deps.context(mount);
      if (context.readOnly) throw new WorkbenchHostError('read-only', 'This file is open read-only, so a view cannot change it.');
      const revision = textParam(params, 'revision', 200);
      if (!ownRevisions.get(mount)?.has(revision))
        throw new WorkbenchHostError('not-this-view', `This view can ${redo ? 'redo' : 'undo'} only what it wrote since it opened.`);
      const label = optionalText(params, 'label', 80);
      const result = await deps.request('data.undoRecordWrites', {
        revisionId: revision, redo, ...(label === undefined ? {} : { label }),
        idempotencyKey: `view-${crypto.randomUUID()}`, actor: `extension:${context.packageId}`,
      });
      return writtenRecords(mount, result);
    },
  };
}

/** The states a proposal is in, as the host numbers them, in the words a view reads. */
const proposalStates = ['draft', 'validating', 'invalid', 'previewable', 'applying', 'active', 'stale', 'failed', 'rejected'];

/** What a view reads of a proposal: its identity, its state and why it is invalid, if it is. */
function plainProposal(result: unknown): Params {
  const preview = (result ?? {}) as { proposalId?: unknown; title?: unknown; state?: unknown; diagnostics?: unknown };
  const state = typeof preview.state === 'number' ? proposalStates[preview.state] ?? 'unknown'
    : typeof preview.state === 'string' ? preview.state.charAt(0).toLowerCase() + preview.state.slice(1) : 'unknown';
  const diagnostics = Array.isArray(preview.diagnostics) ? preview.diagnostics.slice(0, 32).map((item) => {
    const diagnostic = item as { code?: unknown; message?: unknown; severity?: unknown };
    return { code: String(diagnostic.code ?? ''), message: String(diagnostic.message ?? ''), severity: String(diagnostic.severity ?? '') };
  }) : [];
  return { proposalId: String(preview.proposalId ?? ''), title: String(preview.title ?? ''), state, diagnostics };
}

/**
 * The canonical operations a view proposes, each rebuilt: an operation type, its payload as a
 * JSON object, and an operation ID the view chose or one made for it. The host validates the
 * payload exactly as it validates the Workbench's own proposals.
 */
function operationsParam(params: Params): Params[] {
  const value = params.operations;
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw invalid('operations must be a list of 1 to 128 canonical operations.');
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalid(`operations[${index}] must be an object.`);
    const operation = item as Params;
    const operationType = textParam(operation, 'operationType', 64);
    const payload = operation.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw invalid(`operations[${index}].payload must be a JSON object.`);
    const operationId = optionalText(operation, 'operationId', 120) ?? `view-op-${crypto.randomUUID().replaceAll('-', '')}`;
    return { operationId, operationType, payload: plainJson(payload) as Params };
  });
}

/** A proposal ID in the form the host requires. */
function newProposalId(): string {
  return `proposal-${crypto.randomUUID().replaceAll('-', '')}`;
}

/** A proposal of the view's package, opened in the review; the answer says whether it opened. */
function openedProposal(call: MethodCall, preview: unknown): Params {
  const { opened } = call.deps.ui.openProposal(call.mount, preview);
  return { ...plainProposal(preview), opened };
}

/**
 * Where a view's state lives (ADR-0013 Phase 3): its own view ID, or the empty ID the package's
 * views share when `scope` is `package`. Both come from the mount, never from the view.
 */
function stateView(params: Params, context: { viewId: string }): string {
  const scope = params.scope;
  if (scope === undefined || scope === null || scope === 'view') return context.viewId;
  if (scope === 'package') return '';
  throw invalid("scope is 'view', the default, or 'package'.");
}

function stateKey(params: Params): string {
  return textParam(params, 'key', extensionLimits.stateKeyCharacters);
}

/** One kept value as a view reads it: its JSON value and its version, or null for a key never kept. */
function plainState(result: unknown): Params | null {
  const entry = ((result as { entries?: Array<{ key?: unknown; value?: unknown; version?: unknown }> } | null)?.entries ?? [])[0];
  return entry === undefined ? null : { key: String(entry.key ?? ''), value: plainJson(entry.value ?? null), version: Number(entry.version ?? 0) };
}

/**
 * A state write, as the view's package: a value, or null to remove the key. At most two a
 * second from one view reach the host; the API spaces a view's writes wider and coalesces a
 * key written again meanwhile, so only a page that talks to the port directly meets `busy`.
 */
function stateWrite(remove: boolean): MethodEntry {
  return {
    host: 'extension.state.set',
    writes: true,
    run: async ({ params, mount, deps, connection }) => {
      const context = deps.context(mount);
      if (context.readOnly) throw new WorkbenchHostError('read-only', 'This file is open read-only, so a view cannot keep anything in it.');
      const viewId = stateView(params, context);
      const key = stateKey(params);
      const value = remove ? null : plainJson(params.value ?? null);
      const expected = params.expectedVersion;
      if (expected !== undefined && (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0))
        throw invalid('expectedVersion is the key\u2019s version, or 0 for a key that must not exist yet.');
      const now = deps.now();
      connection.stateWrites = connection.stateWrites.filter((at) => at > now - 1_000);
      if (connection.stateWrites.length >= extensionLimits.stateWritesPerSecond)
        throw new WorkbenchHostError('busy', 'A view keeps at most two values a second. The API spaces them for you.');
      connection.stateWrites.push(now);
      const where = viewId === '' ? `the views of ${context.packageId}` : `the view ${context.title}`;
      await deps.request('extension.state.set', {
        viewId, key, value, ...(expected === undefined ? {} : { expectedVersion: expected }),
        description: `${value === null ? 'Forget' : 'Keep'} ${key} for ${where}`.slice(0, 200),
        idempotencyKey: `view-${crypto.randomUUID()}`, actor: `extension:${context.packageId}`,
      });
      if (value === null) return null;
      return plainState(await deps.request('extension.state.read', { viewId, key, actor: `extension:${context.packageId}` }));
    },
  };
}

/** The most record writes one batch carries, as the Engine bounds it. */
const batchWrites = 200;

/** The most a batch may take on the bridge once the broker has added its keys. */
const batchCharacters = 250_000;

/**
 * The writes of one batch, each rebuilt as its single-record form is: a create with its values
 * and a record ID the view chose or one made for it, an update of some fields against the version
 * the view read, or a delete against that version. A record is written at most once in a batch,
 * so the version a view read is the version its write expects.
 */
function recordWritesParam(params: Params): Params[] {
  const value = params.writes;
  if (!Array.isArray(value) || value.length === 0 || value.length > batchWrites)
    throw invalid(`writes must be a list of 1 to ${batchWrites} record writes.`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalid(`writes[${index}] must be an object.`);
    const entry = item as Params;
    let body: Params & { recordId: string };
    try {
      const entityId = textParam(entry, 'entityId');
      if (entry.op === 'create') body = { kind: 'create', entityId, recordId: newRecordId(entry), ...assignedValues(entry) };
      else if (entry.op === 'update') {
        body = { kind: 'update', entityId, recordId: textParam(entry, 'recordId'), expectedRecordVersion: versionParam(entry), ...assignedValues(entry) };
      } else if (entry.op === 'delete') {
        body = { kind: 'delete', entityId, recordId: textParam(entry, 'recordId'), expectedRecordVersion: versionParam(entry) };
      } else throw invalid('op must be create, update or delete.');
    } catch (error) {
      if (error instanceof WorkbenchHostError) throw invalid(`writes[${index}]: ${error.message}`);
      throw error;
    }
    const identity = JSON.stringify([body.entityId, body.recordId]);
    if (seen.has(identity)) throw invalid(`writes[${index}] writes ${body.recordId} again; put a record's changes in one write.`);
    seen.add(identity);
    return body;
  });
}

/** A record ID a view may choose, or one made for it. */
function newRecordId(params: Params): string {
  return optionalText(params, 'recordId', 120) ?? `record-${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * The closed method table: every name a view may call, and the one typed read or write each
 * becomes.
 *
 * Reads, and since Phase 3 the four record writes a person's own edit uses: create, update,
 * delete and run a record command (W-065), a move in a declared tree (W-079), several record
 * writes as one revision (W-102), preparing and reading the package's own
 * proposals, and keeping the view's state with the file (W-069). Nothing here promotes, rejects or approves a proposal; nothing opens,
 * closes or copies a file, and nothing touches a
 * session, an agent, behaviour approval, compensation or the appearance. Each write takes
 * its actor from the mount, never from the view's parameters. The production gate and
 * scripts/extension-broker.test.mjs pin this table.
 */
export const brokerMethods: Readonly<Record<string, MethodEntry>> = Object.freeze({
  'schema.describe': local(({ deps }) => deps.describe()),
  'records.query': read('data.queryRecords', (p) => ({
    entityId: textParam(p, 'entityId'), limit: pageLimit(p), cursor: optionalText(p, 'cursor', 4096) ?? null,
    filters: filterParams(p), sortFieldId: optionalText(p, 'sortFieldId'), descending: optionalBoolean(p, 'descending'),
  }), (result) => plainPage(result as { items?: RecordSnapshot[] })),
  'records.get': read('data.queryRecords', (p) => ({ entityId: textParam(p, 'entityId'), recordId: textParam(p, 'recordId'), limit: 1 }),
    (result) => {
      const item = (result as { items?: RecordSnapshot[] } | null)?.items?.[0];
      return item === undefined ? null : plainRecord(item);
    }),
  // A window of a declared hierarchy, depth-first (ADR-0019).
  'records.tree': read('data.treeRecords', (p) => ({
    entityId: textParam(p, 'entityId'), rootRecordId: optionalText(p, 'rootRecordId', 200) ?? null, depth: treeDepth(p),
    limit: pageLimit(p), cursor: optionalText(p, 'cursor', 4096) ?? null,
  }), (result) => plainTreePage(result as Parameters<typeof plainTreePage>[0])),
  'records.count': read('data.countRecords', (p) => ({ entityId: textParam(p, 'entityId'), filters: filterParams(p) })),
  'records.aggregate': read('data.aggregateRecords', (p) => ({
    entityId: textParam(p, 'entityId'), aggregate: textParam(p, 'aggregate', 32), fieldId: textParam(p, 'fieldId'), filters: filterParams(p),
  })),
  'records.groupAggregate': read('data.groupAggregateRecords', (p) => ({
    entityId: textParam(p, 'entityId'), groupByFieldId: textParam(p, 'groupByFieldId'), aggregate: textParam(p, 'aggregate', 32),
    fieldId: optionalText(p, 'fieldId'), filters: filterParams(p),
  })),
  'records.bucketAggregate': read('data.bucketAggregateRecords', (p) => ({
    entityId: textParam(p, 'entityId'), dateFieldId: textParam(p, 'dateFieldId'), bucket: textParam(p, 'bucket', 32),
    range: textParam(p, 'range', 32), aggregate: textParam(p, 'aggregate', 32), fieldId: optionalText(p, 'fieldId'), filters: filterParams(p),
  })),
  'records.cellAggregate': read('data.cellAggregateRecords', (p) => ({
    entityId: textParam(p, 'entityId'), rowByFieldId: textParam(p, 'rowByFieldId'), columnByFieldId: textParam(p, 'columnByFieldId'),
    aggregate: textParam(p, 'aggregate', 32), fieldId: optionalText(p, 'fieldId'), filters: filterParams(p),
  })),
  'records.create': write('data.createRecord', (p) => ({ entityId: textParam(p, 'entityId'), recordId: newRecordId(p), ...assignedValues(p) })),
  'records.update': write('data.setFields', (p) => ({
    entityId: textParam(p, 'entityId'), recordId: textParam(p, 'recordId'), expectedRecordVersion: versionParam(p), ...assignedValues(p),
  })),
  'records.delete': write('data.deleteRecord', (p) => ({
    entityId: textParam(p, 'entityId'), recordId: textParam(p, 'recordId'), expectedRecordVersion: versionParam(p),
  }), false),
  // A move in the record type's declared tree (ADR-0019, W-079): the Engine refuses a loop and
  // a tree too deep, and renumbers the siblings in the same revision when no gap is left.
  'records.move': write('data.moveRecord', (p) => ({
    entityId: textParam(p, 'entityId'), recordId: textParam(p, 'recordId'), expectedRecordVersion: versionParam(p), ...moveTarget(p),
  })),
  // Several writes as one revision (W-102): they commit together or not at all, and History
  // shows one entry, named by label when the view gives one. The answer is each record's new
  // version, in the order written, and null for a deleted one; read a record again for its values.
  // It names the revision too, which records.undo takes (ADR-0023).
  'records.batch': {
    host: 'data.writeRecords',
    writes: true,
    run: async ({ params, mount, deps }) => {
      const context = deps.context(mount);
      if (context.readOnly) throw new WorkbenchHostError('read-only', 'This file is open read-only, so a view cannot change it.');
      const writes = recordWritesParam(params);
      const label = optionalText(params, 'label', 80);
      const body = {
        writes, ...(label === undefined ? {} : { label }),
        idempotencyKey: `view-${crypto.randomUUID()}`, actor: `extension:${context.packageId}`,
      };
      if (JSON.stringify(body).length > batchCharacters)
        throw new WorkbenchHostError('too-large', 'This batch is too large to send at once; split it into smaller batches.');
      return writtenRecords(mount, await deps.request('data.writeRecords', body));
    },
  },
  // Undo of a revision this frame wrote, and redo of its undo (ADR-0023, W-103).
  'records.undo': undoWrites(false),
  'records.redo': undoWrites(true),
  'commands.run': write('data.executeCommand', (p) => ({
    commandId: textParam(p, 'commandId'), entityId: textParam(p, 'entityId'), recordId: textParam(p, 'recordId'), expectedRecordVersion: versionParam(p),
  })),
  // A view prepares a definition change in its package's name and the person decides it in
  // the ordinary review (ADR-0013 Phase 3, W-069). Nothing here promotes or rejects: the host
  // admits the actor on proposal.prepareChangeSet and proposal.get alone, answers another
  // origin's proposal as not found, and lets one proposal per package wait at a time.
  'proposals.prepare': {
    host: 'proposal.prepareChangeSet',
    writes: true,
    run: async (call) => {
      const context = call.deps.context(call.mount);
      if (context.readOnly) throw new WorkbenchHostError('read-only', 'This file is open read-only, so a view cannot propose a change to it.');
      const title = textParam(call.params, 'title', 200);
      const operations = operationsParam(call.params);
      const preview = await call.deps.request('proposal.prepareChangeSet', {
        proposalId: newProposalId(), title, actor: `extension:${context.packageId}`,
        mutations: [{ idempotencyKey: `view-${crypto.randomUUID()}`, description: title, operations }],
      });
      return openedProposal(call, preview);
    },
  },
  'proposals.get': {
    host: 'proposal.get',
    run: async ({ params, mount, deps }) => plainProposal(await deps.request('proposal.get', {
      proposalId: textParam(params, 'proposalId', 64), actor: `extension:${deps.context(mount).packageId}`,
    })),
  },
  'proposals.open': {
    host: 'proposal.get',
    run: async (call) => openedProposal(call, await call.deps.request('proposal.get', {
      proposalId: textParam(call.params, 'proposalId', 64), actor: `extension:${call.deps.context(call.mount).packageId}`,
    })),
  },
  // What a view keeps with the file (ADR-0013 Phase 3, W-069): small JSON values per view, or
  // shared by the package's views, each a Data revision History names the package on.
  'state.get': {
    host: 'extension.state.read',
    run: async ({ params, mount, deps }) => {
      const context = deps.context(mount);
      return plainState(await deps.request('extension.state.read', {
        viewId: stateView(params, context), key: stateKey(params), actor: `extension:${context.packageId}`,
      }));
    },
  },
  'state.keys': {
    host: 'extension.state.read',
    run: async ({ params, mount, deps }) => {
      const context = deps.context(mount);
      const result = await deps.request('extension.state.read', { viewId: stateView(params, context), actor: `extension:${context.packageId}` });
      return ((result as { entries?: Array<{ key?: unknown; version?: unknown }> } | null)?.entries ?? [])
        .map((entry) => ({ key: String(entry.key ?? ''), version: Number(entry.version ?? 0) }));
    },
  },
  'state.set': stateWrite(false),
  'state.delete': stateWrite(true),
  'ui.openRecord': local(({ mount, params, deps }) =>
    deps.ui.openRecord(mount, { entityId: textParam(params, 'entityId'), recordId: textParam(params, 'recordId') })),
  'ui.openScreen': local(({ mount, params, deps }) => deps.ui.openScreen(mount, { surfaceId: textParam(params, 'surfaceId') })),
  'ui.openStudio': local(({ mount, params, deps }) => deps.ui.openStudio(mount, { entityId: optionalText(params, 'entityId') ?? null })),
  'ui.toast': local(({ mount, params, deps, connection }) => {
    const text = textParam(params, 'text', extensionLimits.toastCharacters);
    const now = deps.now();
    if (now - connection.toastAt < extensionLimits.toastIntervalMs)
      throw new WorkbenchHostError('busy', 'A view may show one message a second.');
    connection.toastAt = now;
    deps.ui.toast(mount, text);
    return null;
  }),
  'ui.setHeight': local(({ mount, params, deps }) => {
    const pixels = params.pixels;
    if (typeof pixels !== 'number' || !Number.isFinite(pixels)) throw invalid('pixels must be a number.');
    const bounded = Math.round(Math.min(extensionLimits.maximumHeight, Math.max(extensionLimits.minimumHeight, pixels)));
    return { pixels: deps.ui.setHeight(mount, bounded) };
  }),
  // The view's controls in Nendo's own chrome (ADR-0013, 2026-09-28; W-090). The declaration is
  // rebuilt into closed kinds and plain text before the Workbench draws anything from it, and
  // the keys it declares are the only ones besides Nendo's that this view may hand back.
  'ui.setToolbar': local(({ mount, params, deps, connection }) => {
    withinRate(connection.toolbars, deps.now(), extensionLimits.toolbarsPerSecond,
      'A view declares its toolbar at most twenty times a second. The API spaces them for you.');
    const toolbar = readToolbar(params);
    connection.keys = new Set(declaredKeys(toolbar).map((entry) => entry.keys));
    deps.ui.setToolbar(mount, toolbar.items.length === 0 && toolbar.add === null ? null : toolbar);
    return null;
  }),
  'ui.showMenu': local(({ mount, params, deps, connection }) => {
    withinRate(connection.menus, deps.now(), extensionLimits.menusPerSecond, 'A view asks for at most four menus a second.');
    return deps.ui.showMenu(mount, readMenu(params));
  }),
  // Where the view is, for Back and Forward (2026-09-29, W-127). The place is plain JSON the
  // Workbench keeps and hands back; it never reads it.
  'ui.setPlace': local(({ mount, params, deps, connection }) => {
    withinRate(connection.places, deps.now(), extensionLimits.placesPerSecond, 'A view declares its place at most twenty times a second.');
    const value = plainJson(params.place ?? null);
    const json = JSON.stringify(value);
    if (utf8Length(json) > extensionLimits.placeBytes)
      throw invalid(`place must be JSON of at most ${extensionLimits.placeBytes} bytes.`);
    const label = optionalText(params, 'label', extensionLimits.labelCharacters) ?? null;
    const replace = optionalBoolean(params, 'replace') ?? false;
    deps.ui.setPlace(mount, { value, label, replace });
    // The view knows its own place: neither the event nor the context goes back to it.
    connection.placeJson = json;
    connection.contextJson = JSON.stringify(deps.context(mount));
    return null;
  }),
});

/** Every method name, in table order: what a view's context lists and `nendo.has` answers. */
export const brokerMethodNames: readonly string[] = Object.freeze(Object.keys(brokerMethods));

/** The table as data: each method, the host method it becomes, and whether it writes, for the guards that pin it. */
export function brokerTable(): Array<{ method: string; host: string | null; writes: boolean }> {
  return Object.entries(brokerMethods).map(([method, entry]) => ({ method, host: entry.host, writes: entry.writes === true }));
}

interface Pending { id: number; method: string; params: unknown }

interface Connection {
  mount: BrokerMount;
  port: MessagePort;
  closed: boolean;
  inFlight: number;
  queue: Pending[];
  toastAt: number;
  /** When this view's recent state writes were sent, for the per-second bound. */
  stateWrites: number[];
  /** When it last declared its toolbar, asked for a menu, and handed a key back, for theirs. */
  toolbars: number[];
  menus: number[];
  keyTimes: number[];
  places: number[];
  /** The place this view has, as it declared it or was last handed it, as JSON. */
  placeJson: string;
  /** The keys its current toolbar declares: the only keys besides Nendo's it may hand back. */
  keys: Set<string>;
  changesAt: number;
  changesPending: number | null;
  changesScheduled: boolean;
  lastHeardAt: number;
  lastPingAt: number;
  ping: { id: number; sentAt: number } | null;
  unresponsive: boolean;
  contextJson: string;
}

export interface ExtensionBroker {
  /** The Workbench window's message listener: answers a hello from a mounted frame. */
  receive(event: { source: unknown; origin: string; data: unknown }): void;
  /** Closes a view's channel, when its frame is stopped, reloaded or gone. */
  disconnect(mount: BrokerMount): void;
  isConnected(mount: BrokerMount): boolean;
  /** The file moved: tell every connected view, at most four times a second each. */
  changes(changeSequence: number): void;
  /** The theme changed: hand every connected view its new colours. */
  theme(theme: ViewTheme): void;
  /** Hand a view its context again, when what it describes has changed. */
  refreshContext(mount: BrokerMount): void;
  /**
   * The person pressed one of the view's controls, in Nendo's toolbar, a menu, Ctrl K or by
   * its key (W-090). Answers whether a connected view was told.
   */
  command(mount: BrokerMount, command: ViewCommand): boolean;
  /**
   * Back or Forward put the view's page somewhere else (W-127): hand the view its place, when
   * it is not the one the view already has.
   */
  place(mount: BrokerMount, place: Json): void;
  /** Ping the views that are due, and notice the ones that stopped answering. Called once a second. */
  tick(): void;
  connectionCount(): number;
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof WorkbenchHostError) return { code: error.code, message: error.message };
  const candidate = error as { code?: unknown; message?: unknown } | null;
  if (typeof candidate?.code === 'string' && typeof candidate.message === 'string') return { code: candidate.code, message: candidate.message };
  return { code: 'failed', message: error instanceof Error ? error.message : 'The request failed.' };
}

export function createExtensionBroker(deps: BrokerDeps): ExtensionBroker {
  const connections = new Map<string, Connection>();
  let nextPing = 1;

  function post(connection: Connection, message: PortMessage): void {
    if (connection.closed) return;
    try { connection.port.postMessage(message); } catch {
      // An answer the channel cannot carry is answered as a failure instead of never.
      if (message.t === 'res' && message.ok)
        connection.port.postMessage({ t: 'res', id: message.id, ok: false, e: { code: 'failed', message: 'The answer could not be sent to the view.' } } satisfies PortMessage);
    }
  }

  function fail(connection: Connection, id: number, code: string, message: string): void {
    post(connection, { t: 'res', id, ok: false, e: { code, message } });
  }

  function close(connection: Connection): void {
    connection.closed = true;
    connection.queue = [];
    connection.port.onmessage = null;
    connection.port.close();
    if (connections.get(connection.mount.key) === connection) connections.delete(connection.mount.key);
  }

  async function run(connection: Connection, pending: Pending): Promise<void> {
    connection.inFlight += 1;
    try {
      if (!deps.running()) throw new WorkbenchHostError('views-off', 'Custom views are off, so this view cannot reach the file.');
      const raw = pending.params;
      if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw)))
        throw invalid('The parameters must be an object.');
      const params = (raw ?? {}) as Params;
      const result = await brokerMethods[pending.method].run({ params, mount: connection.mount, deps, connection });
      post(connection, { t: 'res', id: pending.id, ok: true, r: result === undefined ? null : result });
    } catch (error) {
      const described = describeError(error);
      fail(connection, pending.id, described.code, described.message);
    } finally {
      connection.inFlight -= 1;
      pump(connection);
    }
  }

  function pump(connection: Connection): void {
    while (!connection.closed && connection.inFlight < extensionLimits.inFlight && connection.queue.length > 0)
      void run(connection, connection.queue.shift()!);
  }

  function request(connection: Connection, message: { id?: unknown; m?: unknown; p?: unknown }): void {
    const id = message.id;
    // A request without a usable ID cannot be answered, so it is not run either.
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return;
    const method = typeof message.m === 'string' ? message.m : '';
    if (!Object.prototype.hasOwnProperty.call(brokerMethods, method)) {
      fail(connection, id, 'unknown-method', `${method.slice(0, 80) || 'That'} is not a method this Workbench answers.`);
      return;
    }
    let size: number;
    try { size = utf8Length(JSON.stringify(message.p ?? {}) ?? '', extensionLimits.requestBytes); } catch {
      fail(connection, id, 'invalid-params', 'The parameters are not JSON.');
      return;
    }
    if (size > extensionLimits.requestBytes) {
      fail(connection, id, 'too-large', 'A request may carry at most 256 KiB.');
      return;
    }
    const pending: Pending = { id, method, params: message.p };
    if (connection.inFlight < extensionLimits.inFlight) { void run(connection, pending); return; }
    if (connection.queue.length >= extensionLimits.queued) {
      fail(connection, id, 'busy', 'This view has too many requests waiting. Send more when some have answered.');
      return;
    }
    connection.queue.push(pending);
  }

  function heard(connection: Connection, message: unknown): void {
    if (connection.closed) return;
    connection.lastHeardAt = deps.now();
    if (connection.unresponsive) {
      connection.unresponsive = false;
      deps.responsive?.(connection.mount, true);
    }
    if (typeof message !== 'object' || message === null) return;
    const envelope = message as { t?: unknown; id?: unknown; m?: unknown; p?: unknown; keys?: unknown };
    if (envelope.t === 'req') request(connection, envelope);
    else if (envelope.t === 'pong' && connection.ping !== null && envelope.id === connection.ping.id) connection.ping = null;
    else if (envelope.t === 'ping' && typeof envelope.id === 'number') post(connection, { t: 'pong', id: envelope.id });
    else if (envelope.t === 'key') handKey(connection, envelope.keys);
  }

  /**
   * A key the view hands back (W-090): one of Nendo's own, pressed while the view had focus, or
   * one its toolbar declares. Nothing else is taken, and a view that hands back more than
   * eight a second is not heard for the rest of that second; there is no answer to refuse.
   */
  function handKey(connection: Connection, keys: unknown): void {
    if (typeof keys !== 'string' || !deps.running()) return;
    if (!hostKeys.includes(keys) && !connection.keys.has(keys)) return;
    try { withinRate(connection.keyTimes, deps.now(), extensionLimits.keysPerSecond, ''); } catch { return; }
    deps.ui.key(connection.mount, keys);
  }

  function mountFor(source: unknown): BrokerMount | null {
    if (source === null || source === undefined) return null;
    for (const mount of deps.mounts()) if (mount.frameWindow() === source) return mount;
    return null;
  }

  function sendChanges(connection: Connection): void {
    connection.changesScheduled = false;
    if (connection.closed || connection.changesPending === null) return;
    const sequence = connection.changesPending;
    connection.changesPending = null;
    connection.changesAt = deps.now();
    post(connection, { t: 'evt', n: 'changes', d: sequence });
  }

  return {
    receive(event) {
      const data = event.data as { nendo?: unknown } | null;
      if (typeof data !== 'object' || data === null || data.nendo !== 'hello') return;
      // Only a frame this Workbench mounted, and only from the origin it was mounted at. A
      // frame that has navigated elsewhere keeps its window but not its origin.
      const mount = mountFor(event.source);
      if (mount === null || event.origin !== mount.origin || !deps.running()) return;
      const previous = connections.get(mount.key);
      if (previous !== undefined) close(previous);
      const channel = new MessageChannel();
      const context = deps.context(mount);
      const now = deps.now();
      const connection: Connection = {
        mount, port: channel.port1, closed: false, inFlight: 0, queue: [], toastAt: -Infinity, stateWrites: [],
        toolbars: [], menus: [], keyTimes: [], keys: new Set(), places: [], placeJson: JSON.stringify(context.place ?? null),
        changesAt: -Infinity, changesPending: null, changesScheduled: false,
        lastHeardAt: now, lastPingAt: now, ping: null, unresponsive: false, contextJson: JSON.stringify(context),
      };
      connections.set(mount.key, connection);
      channel.port1.onmessage = (message: MessageEvent) => heard(connection, message.data);
      (event.source as Window).postMessage({ nendo: 'connect', apiVersion, context } satisfies ConnectMessage, mount.origin, [channel.port2]);
      deps.connected?.(mount);
    },

    disconnect(mount) {
      const connection = connections.get(mount.key);
      if (connection !== undefined) close(connection);
    },

    isConnected(mount) {
      return connections.has(mount.key);
    },

    changes(changeSequence) {
      const now = deps.now();
      for (const connection of connections.values()) {
        connection.changesPending = changeSequence;
        if (connection.changesScheduled) continue;
        const wait = connection.changesAt + extensionLimits.changesIntervalMs - now;
        if (wait <= 0) { sendChanges(connection); continue; }
        connection.changesScheduled = true;
        deps.later(() => sendChanges(connection), wait);
      }
    },

    theme(theme) {
      for (const connection of connections.values()) {
        post(connection, { t: 'evt', n: 'theme', d: theme });
        connection.contextJson = JSON.stringify(deps.context(connection.mount));
      }
    },

    refreshContext(mount) {
      const connection = connections.get(mount.key);
      if (connection === undefined) return;
      const context = deps.context(mount);
      const json = JSON.stringify(context);
      if (json === connection.contextJson) return;
      connection.contextJson = json;
      post(connection, { t: 'evt', n: 'context', d: context });
    },

    command(mount, command) {
      const connection = connections.get(mount.key);
      if (connection === undefined || connection.closed) return false;
      post(connection, { t: 'evt', n: 'command', d: { id: command.id, value: command.value, source: command.source } });
      return true;
    },

    place(mount, place) {
      const connection = connections.get(mount.key);
      if (connection === undefined || connection.closed) return;
      const json = JSON.stringify(place);
      if (json === connection.placeJson) return;
      connection.placeJson = json;
      connection.contextJson = JSON.stringify(deps.context(mount));
      post(connection, { t: 'evt', n: 'place', d: place });
    },

    tick() {
      const now = deps.now();
      for (const connection of connections.values()) {
        if (connection.ping !== null) {
          // Not answering is measured from the last thing the view said, and only while a
          // ping is waiting: a window the system held back for a minute has sent nothing to
          // answer, and must not read as a view that stopped.
          if (!connection.unresponsive && now - connection.ping.sentAt >= 2_000 &&
              now - connection.lastHeardAt >= extensionLimits.pongTimeoutMs) {
            connection.unresponsive = true;
            deps.responsive?.(connection.mount, false);
          }
        } else if (now - connection.lastPingAt >= extensionLimits.pingIntervalMs) {
          const id = nextPing++;
          connection.ping = { id, sentAt: now };
          connection.lastPingAt = now;
          post(connection, { t: 'ping', id });
        }
      }
    },

    connectionCount() {
      return connections.size;
    },
  };
}
