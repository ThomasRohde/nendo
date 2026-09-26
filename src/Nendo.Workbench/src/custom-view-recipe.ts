import type { EntitySnapshot, UiNodeSnapshot } from './host-types';
import { storageKindName } from './extension-model';

/**
 * Studio's Add view form (W-062): the choices it may offer, and the proposal it makes.
 *
 * A custom view is a node in the file's screens, and a person used to be able to add one
 * only through an agent's change set. This builds the same canonical operations an agent's
 * inline node expands to -- `ui.addNode`, then one `ui.setProperty` per property in name
 * order -- and sends them through the lane every Studio proposal travels. The host
 * validates it like any other change set, so nothing here is trusted: what this module
 * adds is that the form offers only what the Engine's NUI450 rules accept
 * (NendoSemanticCompiler.Extensions.cs), so a person picks from valid fields rather than
 * learning the rules from a refusal. scripts/custom-view-recipe.test.mjs holds the two
 * sides to each other.
 *
 * No DOM: the form's markup and wiring are in view-packages.ts.
 */

export type ViewKind = 'records' | 'graph' | 'panel';

export const viewKinds: ReadonlyArray<{ kind: ViewKind; nodeKind: string; label: string; detail: string }> = [
  { kind: 'records', nodeKind: 'extensionRecordsSurface', label: 'A screen of records', detail: 'One record type, drawn by the package, listed under View in Use.' },
  { kind: 'graph', nodeKind: 'extensionGraphSurface', label: 'A graph', detail: 'Records joined by a link record type, listed under View in Use.' },
  { kind: 'panel', nodeKind: 'extensionRecordPanel', label: 'A panel on a record page', detail: 'Shown on each record’s page, below what the page already has.' },
];

export interface FieldChoice { fieldId: string; displayName: string }

/** A record type a view may be of: one that exists and is not retired. */
export function viewEntities(entities: readonly EntitySnapshot[]): EntitySnapshot[] {
  return entities.filter((entity) => entity.retired !== true);
}

/**
 * The fields a view may show as its label or status: an active stored field of a kind the
 * host reads, or a calculated field. The Engine's IsShowable, word for word.
 */
export function showableFields(entity: EntitySnapshot): FieldChoice[] {
  const stored = entity.fields
    .filter((field) => field.retired !== true && storageKindName(field.storageKind) !== 'unsupported' &&
      (field.unsupportedStorageKind === null || field.unsupportedStorageKind === undefined))
    .map((field) => ({ fieldId: field.fieldId, displayName: field.displayName }));
  const calculated = (entity.derivedFields ?? []).map((field) => ({ fieldId: field.fieldId, displayName: field.displayName }));
  return [...stored, ...calculated];
}

export interface EdgeChoice {
  entity: EntitySnapshot;
  /** The active Reference fields that point at the node record type. A graph needs two. */
  references: FieldChoice[];
}

/**
 * The record types that can link records of `nodeEntityId` to each other: those with at
 * least two active Reference fields that both target it. Any other choice is the Engine's
 * "two distinct active Reference fields on its edge type" refusal.
 */
export function edgeChoices(entities: readonly EntitySnapshot[], nodeEntityId: string): EdgeChoice[] {
  return viewEntities(entities)
    .map((entity) => ({
      entity,
      references: entity.fields
        .filter((field) => field.retired !== true && storageKindName(field.storageKind) === 'reference' &&
          field.reference?.targetEntityId === nodeEntityId)
        .map((field) => ({ fieldId: field.fieldId, displayName: field.displayName })),
    }))
    .filter((choice) => choice.references.length >= 2);
}

export interface PageChoice { surfaceId: string; nodeId: string; title: string; entityId: string }

/** The record pages a panel can go on: the file's record forms and detail pages, by record type. */
export function pageChoices(nodes: readonly UiNodeSnapshot[], entities: readonly EntitySnapshot[]): PageChoice[] {
  const live = new Set(viewEntities(entities).map((entity) => entity.entityId));
  return nodes
    .filter((node) => node.parentNodeId === null && (node.kind === 'recordForm' || node.kind === 'detailSurface') &&
      typeof node.properties.entityId === 'string' && live.has(node.properties.entityId))
    .map((node) => ({
      surfaceId: node.surfaceId,
      nodeId: node.nodeId,
      entityId: node.properties.entityId as string,
      title: typeof node.properties.title === 'string' && node.properties.title.length > 0 ? node.properties.title : 'Record page',
    }));
}

export interface AddViewInput {
  kind: ViewKind;
  packageId: string;
  title: string;
  /** The view's record type; for a panel, the page's, which the view takes rather than names. */
  entityId: string;
  labelFieldId: string;
  statusFieldId?: string | null;
  edgeEntityId?: string | null;
  sourceFieldId?: string | null;
  targetFieldId?: string | null;
  /** For a panel: the record page it goes on. */
  pageNodeId?: string | null;
}

export interface AddViewContext {
  entities: readonly EntitySnapshot[];
  nodes: readonly UiNodeSnapshot[];
  /** A fresh unique suffix; the form passes a random one, a test a fixed one. */
  id: string;
}

/** Why the choices cannot make a view, in the words the form shows, or null when they can. */
export function refusalFor(input: AddViewInput, context: AddViewContext): string | null {
  const title = input.title.trim();
  if (title.length === 0 || title.length > 120) return 'Give the view a title of up to 120 characters.';
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(input.packageId)) return 'Choose a package this file carries.';
  const entity = viewEntities(context.entities).find((candidate) => candidate.entityId === input.entityId);
  if (entity === undefined) return 'Choose a record type that exists.';
  const showable = new Set(showableFields(entity).map((field) => field.fieldId));
  if (!showable.has(input.labelFieldId)) return `Choose a label field of ${entity.displayName}.`;
  if (input.statusFieldId != null && input.statusFieldId !== '' && !showable.has(input.statusFieldId))
    return `Choose a status field of ${entity.displayName}, or none.`;
  if (input.kind === 'graph') {
    const edge = edgeChoices(context.entities, entity.entityId).find((choice) => choice.entity.entityId === input.edgeEntityId);
    if (edge === undefined)
      return edgeChoices(context.entities, entity.entityId).length === 0
        ? `No record type links ${entity.displayName} records to each other yet. A graph needs one with two reference fields that point at ${entity.displayName}.`
        : `Choose a record type that links ${entity.displayName} records to each other.`;
    const references = new Set(edge.references.map((field) => field.fieldId));
    if (!references.has(input.sourceFieldId ?? '') || !references.has(input.targetFieldId ?? ''))
      return `Choose the two fields of ${edge.entity.displayName} that point at ${entity.displayName}.`;
    if (input.sourceFieldId === input.targetFieldId) return 'The link’s two ends must be different fields.';
  }
  if (input.kind === 'panel') {
    const page = pageChoices(context.nodes, context.entities).find((candidate) => candidate.nodeId === input.pageNodeId);
    if (page === undefined) return 'Choose the record page the panel goes on.';
    if (page.entityId !== entity.entityId) return 'The panel shows the page’s own record type.';
  }
  return null;
}

/**
 * The proposal: one mutation, the view's node and its properties, in the canonical order an
 * agent's inline node expands to. Throws the refusal when the choices cannot make a view.
 */
export function addViewProposal(input: AddViewInput, context: AddViewContext): Record<string, unknown> {
  const refusal = refusalFor(input, context);
  if (refusal !== null) throw new Error(refusal);
  const title = input.title.trim();
  const kind = viewKinds.find((candidate) => candidate.kind === input.kind)!;
  const proposalId = `proposal-${context.id}`;
  const nodeId = `node.view.${context.id}`;
  let surfaceId = `surface.view.${context.id}`;
  let parentNodeId: string | null = null;
  let position = 0;
  const properties: Record<string, unknown> = {
    configuration: '{}',
    labelFieldId: input.labelFieldId,
    packageId: input.packageId,
    title,
  };
  if (input.statusFieldId != null && input.statusFieldId !== '') properties.statusFieldId = input.statusFieldId;
  if (input.kind === 'panel') {
    // A panel takes its record type from the page and goes after what the page already has.
    const page = pageChoices(context.nodes, context.entities).find((candidate) => candidate.nodeId === input.pageNodeId)!;
    surfaceId = page.surfaceId;
    parentNodeId = page.nodeId;
    position = context.nodes.filter((node) => node.surfaceId === page.surfaceId && node.parentNodeId === page.nodeId).length;
  } else {
    properties.definitionVersion = 3;
    properties.entityId = input.entityId;
  }
  if (input.kind === 'graph') {
    properties.edgeEntityId = input.edgeEntityId;
    properties.sourceFieldId = input.sourceFieldId;
    properties.targetFieldId = input.targetFieldId;
  }
  const operations: Array<Record<string, unknown>> = [];
  const operation = (operationType: string, payload: Record<string, unknown>): void => {
    operations.push({ operationId: `${proposalId}-${operations.length.toString().padStart(3, '0')}`, operationType, payload });
  };
  operation('ui.addNode', { surfaceId, nodeId, parentNodeId, kind: kind.nodeKind, position });
  for (const propertyName of Object.keys(properties).sort())
    operation('ui.setProperty', { surfaceId, nodeId, propertyName, value: properties[propertyName] });
  const description = `Show ${title}, drawn by ${input.packageId}`;
  return { proposalId, title: `Add view ${title}`, mutations: [{ idempotencyKey: `${proposalId}-view`, description, operations }] };
}

export interface ViewUse { nodeId: string; surfaceId: string; kind: ViewKind; title: string; entityId: string | null; pageTitle: string | null }

/**
 * Where each package is shown: the views that name it, with the record type a screen is
 * listed under and the page a panel sits on. It answers the owner's question on first use
 * (C-189) -- which package to install to see a graph that was already there.
 */
export function viewsOfPackage(packageId: string, nodes: readonly UiNodeSnapshot[]): ViewUse[] {
  return nodes
    .filter((node) => node.properties.packageId === packageId && viewKinds.some((kind) => kind.nodeKind === node.kind))
    .map((node) => {
      const kind = viewKinds.find((candidate) => candidate.nodeKind === node.kind)!.kind;
      const page = kind === 'panel' ? pageOf(node, nodes) : null;
      return {
        nodeId: node.nodeId,
        surfaceId: node.surfaceId,
        kind,
        title: typeof node.properties.title === 'string' && node.properties.title.length > 0 ? node.properties.title : kind === 'graph' ? 'Custom graph' : 'Custom view',
        entityId: typeof node.properties.entityId === 'string' ? node.properties.entityId : typeof page?.properties.entityId === 'string' ? page.properties.entityId : null,
        pageTitle: page === null ? null : typeof page.properties.title === 'string' ? page.properties.title : 'Record page',
      };
    });
}

/** The root of the page a panel sits on, through any section or tab group between them. */
function pageOf(node: UiNodeSnapshot, nodes: readonly UiNodeSnapshot[]): UiNodeSnapshot | null {
  let current: UiNodeSnapshot | undefined = node;
  while (current !== undefined && current.parentNodeId !== null)
    current = nodes.find((candidate) => candidate.surfaceId === node.surfaceId && candidate.nodeId === current!.parentNodeId);
  return current === undefined || current === node ? null : current;
}
