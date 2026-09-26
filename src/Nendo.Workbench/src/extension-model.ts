import { calculationState } from './calculated-fields';
import { queryOperatorFor } from './record-window';
import { exactNumberText } from './scalars';
import type { DesktopSessionView, EntitySnapshot, RecordSnapshot, UiNodeSnapshot } from './host-types';
import {
  apiVersion,
  type Json, type SchemaDescription, type SchemaEntity, type SchemaField, type ViewBindings, type ViewCalculation,
  type ViewContext, type ViewPage, type ViewPlacement, type ViewRecord, type ViewTheme,
} from './extension-api/protocol';

/**
 * What a custom view is handed, shaped from what the Workbench already holds (ADR-0013).
 *
 * Nothing here reads the document or the session on its own account: every function takes
 * what it describes, so the broker's answers are exercised directly by
 * scripts/extension-broker.test.mjs rather than through a running view.
 */

/**
 * Plain JSON from a value that crossed the host bridge. Every number arrives there in a
 * `{"$nendoNumber": "…"}` envelope that keeps its digits; a view gets the number, and the
 * record shape keeps the digits beside it where they matter.
 */
export function plainJson(value: unknown): Json {
  const lexeme = exactNumberText(value);
  if (lexeme !== null) return Number(lexeme);
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => plainJson(item));
  if (typeof value === 'object') {
    const result: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = plainJson(item);
    return result;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return typeof value === 'string' || typeof value === 'boolean' ? value : null;
}

/**
 * One record as a view reads it: plain values, the exact digits of every number, the label
 * of every reference, and each calculated field with its state. A calculated field's value
 * is also in `values` (null unless the formula produced one), because a view reading a
 * column should not have to know which fields are stored.
 */
export function plainRecord(snapshot: RecordSnapshot): ViewRecord {
  const values: { [fieldId: string]: Json } = {};
  const exact: { [fieldId: string]: string } = {};
  for (const [fieldId, raw] of Object.entries(snapshot.values ?? {})) {
    const lexeme = exactNumberText(raw);
    values[fieldId] = lexeme === null ? plainJson(raw) : Number(lexeme);
    if (lexeme !== null) exact[fieldId] = lexeme;
  }
  const calculated: { [fieldId: string]: ViewCalculation } = {};
  for (const result of snapshot.calculations ?? []) {
    const state = calculationState(result.state);
    const lexeme = state === 'value' ? exactNumberText(result.value) : null;
    const value = state !== 'value' ? null : lexeme === null ? plainJson(result.value) : Number(lexeme);
    calculated[result.fieldId] = {
      state, value, exact: lexeme, errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null,
    };
    if (!(result.fieldId in values)) {
      values[result.fieldId] = value;
      if (lexeme !== null) exact[result.fieldId] = lexeme;
    }
  }
  const labels: { [fieldId: string]: string | null } = {};
  for (const [fieldId, label] of Object.entries(snapshot.referenceLabels ?? {})) labels[fieldId] = label ?? null;
  return { entityId: snapshot.entityId, recordId: snapshot.recordId, version: snapshot.recordVersion, values, exact, labels, calculated };
}

/** A page of the host's records, as a view reads it. */
export function plainPage(page: { items?: RecordSnapshot[]; nextCursor?: string | null; changeSequence?: number }): ViewPage {
  return {
    items: (page.items ?? []).map(plainRecord),
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
    changeSequence: typeof page.changeSequence === 'number' ? page.changeSequence : 0,
  };
}

const storageKinds = ['text', 'integer', 'decimal', 'boolean', 'date', 'dateTime', 'uuid', 'reference', 'unsupported'];
const resultKinds = ['integer', 'decimal', 'boolean', 'text', 'date'];

/** A stored field's kind by name. The host sends the enum's ordinal; the preview sends its name. */
export function storageKindName(kind: string | number): string {
  if (typeof kind === 'number') return storageKinds[kind] ?? 'unsupported';
  return kind.length === 0 ? 'unsupported' : kind[0].toLowerCase() + kind.slice(1);
}

/** A calculated field's result type by name. Its ordinals are not the stored kinds'. */
export function resultKindName(kind: string | number): string {
  if (typeof kind === 'number') return resultKinds[kind] ?? 'text';
  return kind.length === 0 ? 'text' : kind[0].toLowerCase() + kind.slice(1);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function describeEntity(entity: EntitySnapshot): SchemaEntity {
  const stored: SchemaField[] = entity.fields.filter((field) => field.retired !== true).map((field) => ({
    fieldId: field.fieldId,
    displayName: field.displayName,
    storageKind: storageKindName(field.storageKind),
    required: field.required,
    presentation: field.presentation,
    calculated: false,
    expression: null,
    // A field authored before choices carried names lists its options; each is its own name.
    choices: (field.choices ?? []).length > 0
      ? field.choices!.map((choice) => ({ id: choice.id, displayName: choice.displayName, retired: choice.retired, tone: choice.tone ?? null }))
      : field.options.map((option) => ({ id: option, displayName: option, retired: false, tone: null })),
    reference: field.reference ?? null,
    scale: field.scale ?? null,
  }));
  const derived: SchemaField[] = (entity.derivedFields ?? []).map((field) => ({
    fieldId: field.fieldId,
    displayName: field.displayName,
    storageKind: resultKindName(field.resultType),
    required: false,
    presentation: null,
    calculated: true,
    expression: field.expression,
    choices: [],
    reference: null,
    scale: null,
  }));
  return { entityId: entity.entityId, displayName: entity.displayName, fields: [...stored, ...derived] };
}

/** The root a node sits under, through its parents in the same surface. */
function rootOf(node: UiNodeSnapshot, nodes: readonly UiNodeSnapshot[]): UiNodeSnapshot {
  let current = node;
  for (let depth = 0; current.parentNodeId !== null && depth < 64; depth += 1) {
    const parent = nodes.find((candidate) => candidate.nodeId === current.parentNodeId && candidate.surfaceId === node.surfaceId);
    if (parent === undefined) break;
    current = parent;
  }
  return current;
}

const byPosition = (left: UiNodeSnapshot, right: UiNodeSnapshot): number =>
  left.surfaceId < right.surfaceId ? -1 : left.surfaceId > right.surfaceId ? 1
    : left.position - right.position || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);

/**
 * `schema.describe`: the file's record types with every field a view can read (calculated
 * ones included, with their formulas), what the file is for, its screens and its commands.
 * Retired record types and fields are left out, as Studio leaves them out of Data.
 */
export function describeSchema(session: DesktopSessionView): SchemaDescription {
  const nodes = session.uiNodes ?? [];
  return {
    purpose: session.manifest?.purpose ?? null,
    changeSequence: session.manifest?.changeSequence ?? 0,
    entities: session.entities.filter((entity) => entity.retired !== true).map(describeEntity),
    screens: nodes.filter((node) => node.parentNodeId === null && node.kind !== 'recordCommand').sort(byPosition).map((node) => ({
      id: node.nodeId,
      surfaceId: node.surfaceId,
      kind: node.kind,
      title: text(node.properties.title) ?? text(node.properties.label),
      entityId: text(node.properties.entityId),
    })),
    commands: nodes.filter((node) => node.kind === 'recordCommand').sort(byPosition).map((node) => ({
      id: node.nodeId,
      entityId: text(node.properties.entityId) ?? text(rootOf(node, nodes).properties.entityId),
      label: text(node.properties.label),
      steps: nodes.filter((step) => step.kind === 'commandStep' && step.parentNodeId === node.nodeId && step.surfaceId === node.surfaceId)
        .sort(byPosition)
        .map((step) => ({ fieldId: text(step.properties.fieldId) ?? '', valueKind: text(step.properties.valueKind) ?? 'literal', value: plainJson(step.properties.value) })),
    })),
  };
}

/** Which record type holds a field: one of the view's own first, then any in the file. */
function holderOf(session: DesktopSessionView, fieldId: string, preferred: Array<string | null>, fallback: string | null): string {
  const holds = (entity: EntitySnapshot | undefined): boolean => entity !== undefined &&
    (entity.fields.some((field) => field.fieldId === fieldId) || (entity.derivedFields ?? []).some((field) => field.fieldId === fieldId));
  for (const entityId of preferred) {
    if (entityId !== null && holds(session.entities.find((entity) => entity.entityId === entityId))) return entityId;
  }
  return session.entities.find((entity) => holds(entity))?.entityId ?? fallback ?? '';
}

/**
 * What a view's definition binds, read from the stored nodes rather than the compiled plan:
 * a record page's compiled plan leaves out a panel's own children. Each field and filter is
 * given the record type that holds it, the view's own record type before its link type.
 */
export function viewBindings(session: DesktopSessionView, viewId: string, entityId: string | null): ViewBindings {
  const nodes = session.uiNodes ?? [];
  const node = nodes.find((candidate) => candidate.nodeId === viewId);
  const empty: ViewBindings = { labelFieldId: null, statusFieldId: null, edgeEntityId: null, sourceFieldId: null, targetFieldId: null, fields: [], filters: [] };
  if (node === undefined) return empty;
  const edgeEntityId = text(node.properties.edgeEntityId);
  const children = nodes.filter((child) => child.parentNodeId === viewId && child.surfaceId === node.surfaceId).sort(byPosition);
  const holder = (fieldId: string): string => holderOf(session, fieldId, [entityId, edgeEntityId], entityId);
  const fields: ViewBindings['fields'] = [];
  const filters: ViewBindings['filters'] = [];
  for (const child of children) {
    const fieldId = text(child.properties.fieldId);
    if (fieldId === null) continue;
    if (child.kind === 'fieldBinding') fields.push({ fieldId, entityId: holder(fieldId) });
    else if (child.kind === 'filterClause') {
      const operator = text(child.properties.operator);
      if (operator === null) continue;
      const presence = operator === 'isNull' || operator === 'isNotNull';
      const holderId = holder(fieldId);
      const stored = session.entities.find((entity) => entity.entityId === holderId)?.fields.find((field) => field.fieldId === fieldId);
      filters.push({
        fieldId,
        entityId: holderId,
        operator: queryOperatorFor(operator),
        value: presence ? null : plainJson(child.properties.value),
        valueKind: text(child.properties.valueKind) ?? 'literal',
        storageKind: stored === undefined ? 'unsupported' : storageKindName(stored.storageKind),
      });
    }
  }
  return {
    labelFieldId: text(node.properties.labelFieldId),
    statusFieldId: text(node.properties.statusFieldId),
    edgeEntityId,
    sourceFieldId: text(node.properties.sourceFieldId),
    targetFieldId: text(node.properties.targetFieldId),
    fields,
    filters,
  };
}

/** A definition's configuration: JSON text holding an object, or an object; anything else is `{}`. */
export function viewConfiguration(raw: unknown): { [key: string]: Json } {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) as unknown; } catch { return {}; }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return plainJson(parsed) as { [key: string]: Json };
}

/** Where a view is shown, as the placeholder that holds it names it. */
export interface ViewSpec {
  viewId: string;
  kind: string;
  placement: ViewPlacement;
  title: string;
  packageId: string;
  entityId: string | null;
  recordId: string | null;
}

/** The context a view is connected with. */
export function viewContext(
  spec: ViewSpec,
  session: DesktopSessionView,
  theme: ViewTheme,
  locale: string,
  methods: readonly string[],
): ViewContext {
  const node = (session.uiNodes ?? []).find((candidate) => candidate.nodeId === spec.viewId);
  return {
    apiVersion,
    viewId: spec.viewId,
    kind: spec.kind,
    placement: spec.placement,
    title: spec.title,
    packageId: spec.packageId,
    entityId: spec.entityId,
    recordId: spec.recordId,
    bindings: viewBindings(session, spec.viewId, spec.entityId),
    configuration: viewConfiguration(node?.properties.configuration),
    theme,
    locale,
    readOnly: !session.capabilities.mutate,
    methods: [...methods],
  };
}

/**
 * The Workbench's colour tokens, as 02-tokens.css declares them for both themes. A view
 * is handed the values in effect, so its colours follow the person's theme.
 * scripts/extension-broker.test.mjs holds this list to the stylesheet.
 */
export const themeTokenNames = [
  'canvas', 'surface', 'surface-raised', 'surface-soft', 'ink', 'muted', 'line', 'line-strong',
  'cobalt', 'cobalt-soft', 'violet', 'healthy', 'warning', 'danger', 'shadow',
  'tone-red', 'tone-orange', 'tone-amber', 'tone-green', 'tone-teal', 'tone-blue', 'tone-violet', 'tone-grey',
] as const;

/** The theme a view is handed: the mode, and each token's value read through `read`. */
export function viewTheme(mode: 'light' | 'dark', read: (name: string) => string): ViewTheme {
  const tokens: Record<string, string> = {};
  for (const name of themeTokenNames) tokens[name] = read(name).trim();
  return { mode, tokens };
}
