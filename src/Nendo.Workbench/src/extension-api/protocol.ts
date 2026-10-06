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
  /** The most state writes one view sends in any second (ADR-0013 Phase 3); the API spaces them wider. */
  stateWritesPerSecond: 2,
  /** How far apart the API sends one view's state writes, coalescing a key written again meanwhile. */
  stateWriteSpacingMs: 550,
  stateKeyCharacters: 128,
  pingIntervalMs: 5_000,
  /** A view that has said nothing for this long while a ping waits is not responding. */
  pongTimeoutMs: 10_000,
  minimumHeight: 80,
  maximumHeight: 4_000,
  defaultPanelHeight: 360,
  /** A page of records: 1 to 200, 100 when the view names no limit. */
  maximumPageLimit: 200,
  defaultPageLimit: 100,
  /**
   * A view's toolbar in Nendo's chrome (2026-09-28, W-090): at most this many controls in the
   * row, buttons in a group, options in a choice or a select, and items in a menu.
   */
  toolbarItems: 32,
  groupItems: 8,
  choiceOptions: 12,
  selectOptions: 64,
  menuItems: 48,
  /** The most UTF-8 bytes one toolbar or menu declaration may take, as JSON. */
  toolbarBytes: 16 * 1024,
  /** A label, an option or a text: at most this many characters; a menu item's detail line, the second. */
  labelCharacters: 80,
  detailCharacters: 120,
  /** The most toolbars one view declares in any second; the API sends a view's at most every 100 ms. */
  toolbarsPerSecond: 20,
  toolbarSpacingMs: 100,
  /** The most menus one view asks Nendo to draw in any second. */
  menusPerSecond: 4,
  /** The most keys one view hands the Workbench in any second. */
  keysPerSecond: 8,
  /**
   * A view's place in Back and Forward (2026-09-29, W-127): at most this many UTF-8 bytes of
   * JSON, a label of at most `labelCharacters`, and this many declared in any second.
   */
  placeBytes: 4 * 1024,
  placesPerSecond: 20,
} as const;

/**
 * Nendo's own keys, in the form a key is normalised to. A view cannot declare one, and a view
 * does not keep one from Nendo: pressed inside a view, api.js hands it to the Workbench, whose
 * shortcut it is (W-090).
 */
export const hostKeys: readonly string[] = Object.freeze([
  'Ctrl+K', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7',
  'F1', 'Ctrl+B', 'Alt+F', 'Ctrl+/', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Ctrl+T', 'Ctrl+W', 'Ctrl+Tab',
]);

/** Keys named by a word, in the case a normalised key spells them. */
const namedKeys = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Delete', 'Backspace', 'Enter', 'Space', 'Tab', 'Plus',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
];
const symbolKeys = '=-[];\',./\\`';

/**
 * A key as a view declares it, normalised: its modifiers in the order Ctrl, Alt, Shift, then
 * the key, joined by '+'. A letter is upper case; `Plus` stands for '+'. Null when it is not
 * a key a view may declare: a character or a movement key needs Ctrl or Alt, so a key never
 * takes a letter from somebody typing, and only F2 to F12 stand alone.
 */
export function normalizeKeys(text: unknown): string | null {
  const keys = parseKeys(text);
  if (keys === null) return null;
  const parts = keys.split('+');
  const standsAlone = /^F([2-9]|1[0-2])$/.test(parts[parts.length - 1]);
  return parts.includes('Ctrl') || parts.includes('Alt') || standsAlone ? keys : null;
}

/** Any key in the normalised spelling, whether or not a view may declare it; null when it names no key. */
export function parseKeys(text: unknown): string | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 40) return null;
  const parts = text.split('+').map((part) => part.trim());
  const key = parts.pop() ?? '';
  let ctrl = false; let alt = false; let shift = false;
  for (const part of parts) {
    const word = part.toLowerCase();
    if ((word === 'ctrl' || word === 'control') && !ctrl) ctrl = true;
    else if (word === 'alt' && !alt) alt = true;
    else if (word === 'shift' && !shift) shift = true;
    else return null;
  }
  let name: string;
  if (/^[A-Za-z0-9]$/.test(key)) name = key.toUpperCase();
  else if (key.length === 1 && symbolKeys.includes(key)) name = key;
  else {
    const named = namedKeys.find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (named === undefined) return null;
    name = named;
  }
  // A symbol's Shift is the keyboard's business, as chordOf reads it.
  const symbol = name === 'Plus' || symbolKeys.includes(name);
  return [ctrl ? 'Ctrl' : '', alt ? 'Alt' : '', shift && !symbol ? 'Shift' : '', name].filter((part) => part !== '').join('+');
}

export interface KeyEventLike { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/**
 * The normalised key a key event is, for matching against a declaration: null for a bare
 * modifier or the Windows key. A symbol's own shift is left out, because which symbols need
 * Shift depends on the keyboard: Ctrl and '+' is `Ctrl+Plus` on every layout.
 */
export function chordOf(event: KeyEventLike): string | null {
  if (event.metaKey) return null;
  const raw = event.key;
  if (raw === 'Control' || raw === 'Alt' || raw === 'Shift' || raw === 'Meta' || raw === 'AltGraph' || raw === 'Dead') return null;
  let name: string;
  let symbol = false;
  if (raw === ' ') name = 'Space';
  else if (raw === '+') { name = 'Plus'; symbol = true; }
  else if (/^[A-Za-z0-9]$/.test(raw)) name = raw.toUpperCase();
  else if (raw.length === 1) { name = raw; symbol = true; }
  else name = namedKeys.find((candidate) => candidate === raw) ?? '';
  if (name === '') return null;
  const shift = event.shiftKey && !symbol;
  return [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', shift ? 'Shift' : '', name].filter((part) => part !== '').join('+');
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ViewTheme {
  mode: 'light' | 'dark';
  /** The Workbench's colour tokens for the theme in effect, by name without the leading `--`. */
  tokens: Record<string, string>;
}

/**
 * One authored narrowing of what a view reads. `operator` is already the query's word
 * (`le`, not `lte`), and `valueKind` says whether `value` is the literal to compare or a
 * word such as `today` that is resolved when the query is made. `storageKind` is the field's
 * stored kind (`date`, `dateTime`, ...), which says whether `today` is a date or an instant.
 */
export interface ViewFilter {
  fieldId: string;
  entityId: string;
  operator: string;
  value: Json;
  valueKind: string;
  storageKind: string;
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
  /**
   * Where Back or Forward put this view, as it last declared with `nendo.ui.setPlace`; null
   * when it has declared none here (W-127). A view starts from it, and hears the event `place`
   * when Back or Forward moves it while it runs.
   */
  place?: Json | null;
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

/** One record of a tree window (ADR-0019): its parent, its depth below the window's root and its child count. */
export interface ViewTreeNode {
  record: ViewRecord;
  parentRecordId: string | null;
  depth: number;
  childCount: number;
}

export interface ViewTreePage {
  items: ViewTreeNode[];
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

/**
 * A record type. `hierarchy` is the tree it declares (ADR-0019): the self-reference that holds
 * each record's parent, and the whole-number field that orders siblings, if any. Null when it
 * declares none. `linkRule` says which links it allows (ADR-0026): a link whose kinds no record of
 * the table holds is refused at the end of the batch that writes it. Null when it declares none.
 */
export interface SchemaEntity {
  entityId: string;
  displayName: string;
  fields: SchemaField[];
  hierarchy: { parentFieldId: string; orderFieldId: string | null } | null;
  linkRule: { sourceFieldId: string; targetFieldId: string; kindFieldId: string; sourceKindFieldId: string; targetKindFieldId: string; tableEntityId: string; tableSourceFieldId: string; tableTargetFieldId: string; tableKindFieldId: string } | null;
}

/** A screen the file defines: a root node, by its node ID and the surface that holds it. */
export interface SchemaScreen { id: string; surfaceId: string; kind: string; title: string | null; entityId: string | null }

/**
 * One step of a record command: the field it sets and to what. `valueKind` is `literal` (the
 * value is `value`), `null`, or a moment resolved when it runs (`today`, `now`). A view can tell
 * a command is spent on a record when every step with a fixed value already holds it, which is
 * how the record page greys its own buttons.
 */
export interface SchemaCommandStep { fieldId: string; valueKind: string; value: unknown }

export interface SchemaCommand { id: string; entityId: string | null; label: string | null; steps: SchemaCommandStep[] }

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

/** Every event a view can hear; `nendo.on` refuses any other name. */
export const viewEventNames = Object.freeze(['context', 'theme', 'changes', 'command', 'place'] as const);
export type ViewEventName = typeof viewEventNames[number];

/** Where a command came from: a control in the toolbar, a menu, Ctrl K, its key, or Nendo's Add. */
export type CommandSource = 'toolbar' | 'menu' | 'palette' | 'key' | 'add';

/**
 * The event `command`: the person pressed one of the view's controls. `value` is the new state
 * where the control has one: a toggle's or a check's pressed state, the option chosen, the
 * text searched for, a radio item's value. Null for a button and a menu item.
 */
export interface ViewCommand { id: string; value: string | boolean | null; source: CommandSource }

export type PortMessage =
  | { t: 'req'; id: number; m: string; p?: unknown }
  | { t: 'res'; id: number; ok: true; r: unknown }
  | { t: 'res'; id: number; ok: false; e: { code: string; message: string } }
  | { t: 'evt'; n: ViewEventName; d: unknown }
  | { t: 'ping'; id: number }
  | { t: 'pong'; id: number }
  // A key pressed inside the view that is Nendo's, or one the view declared: the Workbench
  // runs it as if it had been pressed there. Normalised, as normalizeKeys spells it.
  | { t: 'key'; keys: string };

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
