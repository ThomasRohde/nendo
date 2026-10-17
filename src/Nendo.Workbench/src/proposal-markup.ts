import type { ViewName } from './app-state';
import { viewsOfPackage, viewUsePlace } from './custom-view-recipe';
import { escapeHtml, reversibilityLabel } from './format';
import type { ApplicationPlan, EntitySnapshot, ExtensionPackageView, ProposalPreview, SemanticDiffEntry, SurfaceNodePlan, UiNodeSnapshot } from './host-types';
import { kindLabel } from './surface-model';

/**
 * Studio's proposal review, the parts that need no page: the mark beside each change, where the
 * change lands, what a removed package leaves without code, whether History will undo it, and
 * where accepting takes the person. view-proposal.ts draws them; a node test reads them back.
 */

export type ChangeMark = 'add' | 'remove' | 'change';

const removals = new Set(['removeExtensionPackage', 'removeExtensionFile', 'removeUiNode', 'removeUiProperty', 'deleteRecord',
  'removeHierarchy', 'removeLinkRule', 'removeBehaviourDefinition']);
const additions = new Set(['addEntity', 'addField', 'addChoice', 'addUiNode', 'createRecord', 'declareHierarchy', 'declareLinkRule']);

/**
 * Whether a line adds, takes away or changes. Every line wore a plus, so "Remove the package
 * Board glance from this file" and "Retire Energy on Task" read as additions (UIT-09).
 */
export function changeMark(entry: Pick<SemanticDiffEntry, 'kind' | 'summary'>): ChangeMark {
  if (removals.has(entry.kind)) return 'remove';
  if (entry.kind === 'setRetired') return entry.summary.startsWith('Retire') ? 'remove' : 'add';
  if (additions.has(entry.kind)) return 'add';
  // A package or a file the file does not have yet is said as "Add …"; an existing one as Update or Replace.
  if ((entry.kind === 'setExtensionPackage' || entry.kind === 'putExtensionFile') && entry.summary.startsWith('Add ')) return 'add';
  return 'change';
}

const glyphs: Record<ChangeMark, string> = { add: '＋', remove: '－', change: '•' };

const dataKinds = new Set(['setField', 'backfillRetiredField', 'deleteRecord', 'createRecord', 'restoreDeletedRecord', 'setRecordKeptInNewFiles']);
const packageKinds = new Set(['setExtensionPackage', 'putExtensionFile', 'removeExtensionFile', 'removeExtensionPackage', 'extensionCode', 'extensionSkill']);

/**
 * Whether History will offer Undo for this proposal once accepted, as History judges it: one
 * change, a batch of record changes, or a package with its files (SqliteNendoStore.ReadQueries).
 * Add view is one node and its settings together, so History never offers it, while every line
 * of its review read "Can be undone" (UIT-04).
 */
export function historyOffersUndo(preview: Pick<ProposalPreview, 'operationCount' | 'semanticDiff'>): boolean {
  const kinds = preview.semanticDiff.map((entry) => entry.kind);
  if (preview.operationCount === 1) return true;
  return kinds.length > 0 && (kinds.every((kind) => dataKinds.has(kind)) || kinds.every((kind) => packageKinds.has(kind)));
}

/** A line's class, and whether History will undo it: the class alone read as a promise (UIT-04). */
export function reviewReversibility(entry: Pick<SemanticDiffEntry, 'reversibility'>, undoneFromHistory: boolean): string {
  const label = reversibilityLabel(entry.reversibility);
  return undoneFromHistory || label === 'Cannot be undone' ? label : `${label}, but not from History`;
}

export function proposalChangesMarkup(preview: Pick<ProposalPreview, 'operationCount' | 'semanticDiff'>): string {
  const undone = historyOffersUndo(preview);
  return preview.semanticDiff.map((entry) => {
    const mark = changeMark(entry);
    return `<article><span class="change-mark" data-change="${mark}" aria-hidden="true">${glyphs[mark]}</span><div><strong>${escapeHtml(entry.summary)}</strong><p>${escapeHtml(reviewReversibility(entry, undone))}</p></div></article>`;
  }).join('');
}

/** The sentence under the preview when History will not undo the proposal as a whole (UIT-04). */
export function historyUndoNote(preview: Pick<ProposalPreview, 'operationCount' | 'semanticDiff'>): string {
  if (historyOffersUndo(preview) || preview.semanticDiff.every((entry) => reversibilityLabel(entry.reversibility) === 'Cannot be undone')) return '';
  return '<p class="proposal-undo-note">History will not offer Undo for this as a whole: it undoes one change, a batch of record changes, or a package with its files. A later proposal can change it back.</p>';
}

/** Where a proposal lands: the record types and the screens its changes address. */
export interface ProposalPlace {
  types: string[];
  screens: string[];
  /** The record type and screen the read-only preview opens on, when the change touches one. */
  start: { entityId: string; surfaceId: string | null } | null;
}

function allNodes(nodes: readonly SurfaceNodePlan[]): SurfaceNodePlan[] {
  return nodes.flatMap((node) => [node, ...allNodes(node.children)]);
}

function rootName(root: SurfaceNodePlan): string {
  for (const key of ['title', 'label'] as const) {
    const value = root.properties[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return kindLabel(root.kind);
}

/**
 * The record types and screens the change set itself addresses, read from the IDs its lines
 * carry. The panel named the first record type and the first titled screen of the whole
 * candidate, so a board rename read "Screen" with the record form's name and a field added to a second type read
 * as a change to the first (UIT-01).
 */
export function proposalPlace(diff: readonly SemanticDiffEntry[], plans: readonly ApplicationPlan[], entities: readonly Pick<EntitySnapshot, 'entityId' | 'displayName'>[]): ProposalPlace {
  const ids = new Set(diff.flatMap((entry) => entry.semanticIds));
  const types: string[] = [];
  const screens: string[] = [];
  let start: ProposalPlace['start'] = null;
  const addType = (name: string): void => { if (!types.includes(name)) types.push(name); };
  for (const plan of plans) {
    const entityId = plan.entity.semanticId;
    const touchedRoots = plan.surfaces.filter((root) => ids.has(root.semanticId) || allNodes(root.children).some((node) => ids.has(node.semanticId)));
    if (ids.has(entityId) || touchedRoots.length > 0) addType(plan.entity.displayName);
    for (const root of touchedRoots) screens.push(rootName(root));
    if (start === null && touchedRoots.length > 0) start = { entityId, surfaceId: touchedRoots[0].semanticId };
    else if (start === null && ids.has(entityId)) start = { entityId, surfaceId: null };
  }
  // A record type the candidate draws no screen for still has a name.
  for (const entity of entities) if (ids.has(entity.entityId) && !plans.some((plan) => plan.entity.semanticId === entity.entityId)) addType(entity.displayName);
  return { types, screens, start };
}

export function proposalPlaceMarkup(place: ProposalPlace, operationCount: number): string {
  const rows: string[] = [];
  if (place.types.length > 0) rows.push(`<div><dt>${place.types.length === 1 ? 'Record type' : 'Record types'}</dt><dd>${escapeHtml(place.types.join(', '))}</dd></div>`);
  if (place.screens.length > 0) rows.push(`<div><dt>${place.screens.length === 1 ? 'Screen' : 'Screens'}</dt><dd>${escapeHtml(place.screens.join(', '))}</dd></div>`);
  rows.push(`<div><dt>Proposed changes</dt><dd>${operationCount}</dd></div>`);
  return `<dl class="proposal-place">${rows.join('')}</dl>`;
}

/** The nodes above a use, up to its root, within its own surface. */
function ancestorsOf(use: { nodeId: string; surfaceId: string }, nodes: readonly UiNodeSnapshot[]): string[] {
  const ids: string[] = [];
  let current = nodes.find((node) => node.surfaceId === use.surfaceId && node.nodeId === use.nodeId);
  while (current !== undefined && current.parentNodeId !== null && ids.length < 64) {
    ids.push(current.parentNodeId);
    const parentId: string = current.parentNodeId;
    current = nodes.find((node) => node.surfaceId === use.surfaceId && node.nodeId === parentId);
  }
  return ids;
}

/**
 * What a removed package leaves without code: each screen and panel that names it, by title and
 * place, less any the same proposal removes. The review said only "a view that uses the
 * package", and an agent's removal is reviewed nowhere else (UIT-20).
 */
export function packageRemovalMarkup(
  diff: readonly SemanticDiffEntry[],
  nodes: readonly UiNodeSnapshot[],
  entities: readonly Pick<EntitySnapshot, 'entityId' | 'displayName'>[],
  packages: readonly Pick<ExtensionPackageView, 'packageId' | 'title'>[],
): string {
  const removedNodes = new Set(diff.filter((entry) => entry.kind === 'removeUiNode').flatMap((entry) => entry.semanticIds));
  const removed: string[] = [];
  diff.forEach((entry, index) => {
    if (entry.kind !== 'removeExtensionPackage' || entry.semanticIds.length === 0) return;
    const packageId = entry.semanticIds[0];
    // Put back later in the same change set, the package is replaced rather than gone.
    if (diff.slice(index + 1).some((later) => later.kind === 'setExtensionPackage' && later.semanticIds.includes(packageId))) return;
    if (!removed.includes(packageId)) removed.push(packageId);
  });
  return removed.map((packageId) => {
    const title = packages.find((pkg) => pkg.packageId === packageId)?.title ?? packageId;
    // A view the same proposal removes, or one on a page it removes, will not show the notice.
    const uses = viewsOfPackage(packageId, nodes).filter((use) => !removedNodes.has(use.nodeId) && !ancestorsOf(use, nodes).some((id) => removedNodes.has(id)));
    if (uses.length === 0) return `<p class="package-removal-uses" data-package-removal="${escapeHtml(packageId)}">No screen or record page uses ${escapeHtml(title)}.</p>`;
    return `<div class="package-removal-uses" data-package-removal="${escapeHtml(packageId)}"><p>${uses.length === 1 ? 'This view then says' : `These ${uses.length} views then say`} that ${escapeHtml(title)} is missing:</p><ul>${uses.map((use) =>
      `<li><strong>${escapeHtml(use.title)}</strong> <span>${escapeHtml(viewUsePlace(use, entities))}</span></li>`).join('')}</ul></div>`;
  }).join('');
}

/**
 * Whether Studio itself prepared the proposal, the one kind its Discard may reject. Studio's
 * proposals carry the origin workbench; an agent's, opened here by a retried acceptance, and a
 * custom view's are someone else's work to keep or reject.
 */
export function isStudioPrepared(preview: Pick<ProposalPreview, 'origin'>): boolean {
  return preview.origin === 'workbench';
}

/**
 * Where accepting takes the person (UIT-02). A proposal Studio prepared goes back to the page it
 * came from, where the change shows; every proposal landed on Use when the file had screens, so
 * a field added on Structure was accepted onto a screen that did not show it. Only a proposal
 * that builds the file's first screens lands on Use, where they now are.
 */
export function viewAfterAccepting(input: { returnView: ViewName; buildsScreens: boolean; hadScreens: boolean; fromView: boolean; codeOnly: boolean; landsOn?: ViewName | null }): ViewName {
  // A view the Add view form made opens where it is (W-062), whatever page the form was on.
  if (input.landsOn != null) return input.landsOn;
  if (input.fromView || input.codeOnly) return input.returnView;
  return input.buildsScreens && !input.hadScreens ? 'use' : input.returnView;
}

/**
 * What a Studio form says when the host refuses its change on the copy of the file: the host's
 * own words, said in the form, which keeps what was typed (WSP-19).
 */
export function proposalRefusal(preview: Pick<ProposalPreview, 'diagnostics'>): string {
  const said = preview.diagnostics.map((item) => `${item.message} ${item.hint ?? ''}`.trim()).filter((text) => text !== '');
  return `${said.length === 0 ? 'The file refused this change.' : said.join(' ')} Nothing in the file changed.`;
}
