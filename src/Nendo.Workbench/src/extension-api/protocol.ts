/**
 * What a custom view and the Workbench say to each other (ADR-0013), and the shapes they
 * carry. Both ends are built from this file: the in-frame client (nendo-api.ts, served as
 * /_nendo/api.js on every view origin) and the Workbench's broker (extension-broker.ts).
 * It holds types and constants only, so either bundle can take it whole.
 *
 * The handshake: the view posts a hello to its parent window; the broker answers with a
 * connect message carrying the view's context and one end of a fresh MessageChannel.
 * Everything after that travels on the port.
 */

export const apiVersion = 1;

/**
 * The bounds a view meets at the broker. api.js keeps an honest view inside them, so a
 * refusal is what a view that bypasses it sees.
 */
export const extensionLimits = {
  /** The most UTF-8 bytes one request's parameters may take, as JSON. */
  requestBytes: 256 * 1024,
  /** Requests one view may have in flight at once. */
  inFlight: 8,
  /** Requests one view may have waiting behind those; the next is refused as busy. */
  queued: 64,
  /** The fewest milliseconds between two `changes` events to one view: four a second. */
  changesIntervalMs: 250,
  /** The fewest milliseconds between two toasts from one view. */
  toastIntervalMs: 1_000,
  toastCharacters: 300,
  pingIntervalMs: 5_000,
  /** A view that has said nothing for this long while a ping waits is not responding. */
  pongTimeoutMs: 10_000,
  minimumHeight: 80,
  maximumHeight: 4_000,
  defaultPanelHeight: 360,
  /** A page of records: 1 to 200, 100 when the view names no limit. */
  maximumPageLimit: 200,
  defaultPageLimit: 100,
} as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ViewTheme {
  mode: 'light' | 'dark';
  /** The Workbench's colour tokens for the theme in effect, by name without the leading `--`. */
  tokens: Record<string, string>;
}

/**
 * One authored narrowing of what a view reads. `operator` is already the query's word
 * (`le`, not `lte`), and `valueKind` says whether `value` is the literal to compare or a
 * word such as `today` that is resolved when the query is made.
 */
export interface ViewFilter {
  fieldId: string;
  entityId: string;
  operator: string;
  value: Json;
  valueKind: string;
}

export interface ViewBindings {
  labelFieldId: string | null;
  statusFieldId: string | null;
  edgeEntityId: string | null;
  sourceFieldId: string | null;
  targetFieldId: string | null;
  /** The further fields the definition names, each with the record type that holds it. */
  fields: Array<{ fieldId: string; entityId: string }>;
  filters: ViewFilter[];
}

export type ViewPlacement = 'screen' | 'recordPage' | 'tile';

export interface ViewContext {
  apiVersion: number;
  viewId: string;
  kind: string;
  placement: ViewPlacement;
  title: string;
  packageId: string;
  entityId: string | null;
  /** The page's record, for a view on a record page; null elsewhere. */
  recordId: string | null;
  bindings: ViewBindings;
  /** The definition's configuration, parsed; `{}` when there is none or it does not parse. */
  configuration: { [key: string]: Json };
  theme: ViewTheme;
  locale: string;
  readOnly: boolean;
  /** Every method this Workbench answers. `nendo.has(name)` reads it. */
  methods: string[];
}

export type CalculationStateName = 'value' | 'empty' | 'error' | 'pending';

/** One calculated field of a record: a value, empty, an error, or not computed yet. */
export interface ViewCalculation {
  state: CalculationStateName;
  value: Json;
  /** The exact digits of a numeric value, which `value` may round. */
  exact: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * A record as a view reads it. `values` are plain JSON: a number is a number, a choice is
 * its option ID, a reference is the target record's ID, and a calculated field is its
 * value (null unless it has one). `exact` keeps the digits of every number, which a
 * JavaScript number can round; `labels` names what each reference points at.
 */
export interface ViewRecord {
  entityId: string;
  recordId: string;
  version: number;
  values: { [fieldId: string]: Json };
  exact: { [fieldId: string]: string };
  labels: { [fieldId: string]: string | null };
  calculated: { [fieldId: string]: ViewCalculation };
}

export interface ViewPage {
  items: ViewRecord[];
  nextCursor: string | null;
  changeSequence: number;
}

export interface SchemaChoice { id: string; displayName: string; retired: boolean; tone: string | null }

export interface SchemaField {
  fieldId: string;
  displayName: string;
  /** `text`, `integer`, `decimal`, `boolean`, `date`, `dateTime`, `uuid` or `reference`. */
  storageKind: string;
  required: boolean;
  presentation: string | null;
  /** A calculated field: read-only, and computed from the formula in `expression`. */
  calculated: boolean;
  expression: string | null;
  choices: SchemaChoice[];
  reference: { targetEntityId: string; labelFieldId: string } | null;
  scale: { min: number; max: number } | null;
}

export interface SchemaEntity { entityId: string; displayName: string; fields: SchemaField[] }

/** A screen the file defines: a root node, by its node ID and the surface that holds it. */
export interface SchemaScreen { id: string; surfaceId: string; kind: string; title: string | null; entityId: string | null }

export interface SchemaCommand { id: string; entityId: string | null; label: string | null }

export interface SchemaDescription {
  purpose: string | null;
  changeSequence: number;
  entities: SchemaEntity[];
  screens: SchemaScreen[];
  commands: SchemaCommand[];
}

/** What loadGraph answers: records as nodes, link records as edges between them. */
export interface ViewGraph {
  nodes: Array<{ id: string; label: string; status: Json; values: { [fieldId: string]: Json }; record: ViewRecord }>;
  edges: Array<{ id: string; source: string; target: string; values: { [fieldId: string]: Json }; record: ViewRecord }>;
  fields: Array<{ fieldId: string; entityId: string; displayName: string; storageKind: string }>;
  /** Links left out because an end is not among the nodes. */
  hiddenEdges: number;
}

export interface HelloMessage { nendo: 'hello'; apiVersion: number }
export interface ConnectMessage { nendo: 'connect'; apiVersion: number; context: ViewContext }

export type ViewEventName = 'context' | 'theme' | 'changes';

export type PortMessage =
  | { t: 'req'; id: number; m: string; p?: unknown }
  | { t: 'res'; id: number; ok: true; r: unknown }
  | { t: 'res'; id: number; ok: false; e: { code: string; message: string } }
  | { t: 'evt'; n: ViewEventName; d: unknown }
  | { t: 'ping'; id: number }
  | { t: 'pong'; id: number };

/** The UTF-8 length of a string, counted without encoding it, stopping once past `limit`. */
export function utf8Length(text: string, limit = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let index = 0; index < text.length && bytes <= limit; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
