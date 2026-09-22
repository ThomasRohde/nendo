import { prepareApplication } from './actions';
import { state } from './app-state';
import { escapeAttribute, escapeHtml, fieldName, messageFor } from './format';
import { type ApplicationPlan, type CompileResult, type SurfaceNodePlan } from './host';
import { type IconName, icon } from './icons';
import { activePlan, applicationPlans, currentRecipe } from './plan-selection';
import { content, requiredElement, rerender, showError } from './shell';
import { renameBoardProposal } from './studio';
import { descendants, surfaceRoot } from './surface-model';
/**
 * The Studio catalogue of compiled surfaces: what the current definition builds,
 * what each root is bound to, and what the compiler refused.
 */

export function renderSurfaces(): void {
  const plan = activePlan();
  const valid = plan !== null;
  const recipe = currentRecipe();
  content.innerHTML = `<div class="studio-page">
    ${!valid && recipe !== null ? `<header class="page-heading"><button id="prepare-application" class="primary-button" data-action type="button">${escapeHtml(recipe.actionLabel)}</button></header>` : ''}
    <div class="message-slot" role="alert" hidden></div>
    ${valid ? `<div class="page-toolbar"><label class="select-field">Record type<select id="surface-entity">${applicationPlans().map(app => `<option value="${escapeAttribute(app.entity.semanticId)}" ${app.entity.semanticId === plan.entity.semanticId ? 'selected' : ''}>${escapeHtml(app.entity.displayName)}</option>`).join('')}</select></label><span class="toolbar-spacer"></span><span class="record-total">${surfaceCount(plan)} surfaces</span></div><div class="surface-list">
      ${plan.surfaces.map((root) => treeSurfaceCard(plan, root)).join('')}
    </div>
    ${boardRename(plan)}`
      : diagnosticsMarkup(state.compilation)}
  </div>`;
  content.querySelector<HTMLSelectElement>('#surface-entity')?.addEventListener('change', event => {
    state.selectedApplicationEntity = (event.currentTarget as HTMLSelectElement).value; rerender();
  });
  content.querySelector<HTMLButtonElement>('#prepare-application')?.addEventListener('click', () => {
    if (recipe !== null) void prepareApplication(recipe, 'surfaces');
  });
  content.querySelector<HTMLFormElement>('#rename-board-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = requiredElement<HTMLInputElement>('#board-title').value.trim();
    if (plan === null || title.length === 0 || title === boardRootTitle(plan)) return;
    try {
      // The compiled plan names the root; the node it compiled from names the surface
      // the operation must address.
      const root = surfaceRoot(plan, 'boardSurface');
      const surfaceId = state.session.uiNodes.find((node) => node.nodeId === root?.semanticId)?.surfaceId;
      if (root === null || surfaceId === undefined) throw new Error('This board is no longer in the open file. Read again before renaming it.');
      void prepareApplication({ actionLabel: 'Rename', applicationName: plan.entity.displayName, proposalPayload: renameBoardProposal(surfaceId, root.semanticId, title) }, 'surfaces');
    } catch (error) { showError(messageFor(error)); }
  });
}

export function surfaceCount(plan: ApplicationPlan): number {
  return plan.surfaces.length;
}

export function boardRootTitle(plan: ApplicationPlan): string | null {
  const root = surfaceRoot(plan, 'boardSurface');
  return typeof root?.properties.title === 'string' ? root.properties.title : null;
}

// Renaming a board is the Studio-owned proposal the outcome review drives. It is
// offered only where there is a board root to rename.
export function boardRename(plan: ApplicationPlan): string {
  const title = boardRootTitle(plan);
  if (title === null) return '';
  return `<form id="rename-board-form" class="rename-form"><label for="board-title">Board title</label><input id="board-title" maxlength="120" required value="${escapeAttribute(title)}" /><button class="secondary-button" data-action type="submit">Preview rename</button></form>`;
}

// Contract version 3 roots are described from the compiled tree rather than from
// the version 1 and 2 slots, which a version 3 plan leaves empty.
export function treeSurfaceCard(plan: ApplicationPlan, root: SurfaceNodePlan): string {
  const title = typeof root.properties.title === 'string' ? root.properties.title : plan.entity.displayName;
  const bindings = descendants(root.children, 'fieldBinding').length;
  const sections = descendants(root.children, 'section').length;
  const relations = descendants(root.children, 'relatedList');
  const parts: string[] = [];
  switch (root.kind) {
    case 'detailSurface':
      parts.push('Record page');
      parts.push(`${bindings} ${bindings === 1 ? 'field' : 'fields'}`);
      if (sections > 0) parts.push(`${sections} ${sections === 1 ? 'section' : 'sections'}`);
      if (relations.length > 0) parts.push(relations.map((node) => relationDescription(node)).join(', '));
      break;
    case 'recordForm':
      parts.push('Record form');
      parts.push(`${bindings} stored ${bindings === 1 ? 'field' : 'fields'}`);
      if (sections > 0) parts.push(`${sections} ${sections === 1 ? 'section' : 'sections'}`);
      break;
    case 'recordList':
      parts.push('List', `${bindings} fields in stored order`);
      break;
    case 'boardSurface':
      parts.push('Board');
      if (typeof root.properties.groupByFieldId === 'string') parts.push(`grouped by ${fieldName(plan, root.properties.groupByFieldId)}`);
      break;
    case 'calendarSurface':
      parts.push('Calendar');
      if (typeof root.properties.dateFieldId === 'string') parts.push(`by ${fieldName(plan, root.properties.dateFieldId)}`);
      break;
    case 'timelineSurface':
      parts.push('Timeline');
      if (typeof root.properties.dateFieldId === 'string') parts.push(`by ${fieldName(plan, root.properties.dateFieldId)}`);
      if (typeof root.properties.endDateFieldId === 'string') parts.push(`spans to ${fieldName(plan, root.properties.endDateFieldId)}`);
      break;
    case 'gallerySurface':
      parts.push('Gallery', `${bindings} ${bindings === 1 ? 'field' : 'fields'} on each card`);
      if (typeof root.properties.titleFieldId === 'string') parts.push(`titled by ${fieldName(plan, root.properties.titleFieldId)}`);
      if (typeof root.properties.accentFieldId === 'string') parts.push(`toned by ${fieldName(plan, root.properties.accentFieldId)}`);
      break;
    case 'recordCommand':
      parts.push('Action');
      if (typeof root.properties.fieldId === 'string') parts.push(`sets ${fieldName(plan, root.properties.fieldId)}`);
      break;
    default:
      parts.push(root.kind);
      break;
  }
  return surfaceCard(cardKindFor(root.kind), title, root.semanticId, parts.join(' · '));
}

export function relationDescription(node: SurfaceNodePlan): string {
  const target = typeof node.properties.targetEntityId === 'string' ? node.properties.targetEntityId : 'related records';
  const entity = state.session.entities.find((candidate) => candidate.entityId === target);
  return `related ${entity?.displayName ?? target}`;
}

export function cardKindFor(kind: string): string {
  switch (kind) {
    case 'recordForm': return 'Form';
    case 'detailSurface': return 'Form';
    case 'recordList': return 'List';
    case 'boardSurface': return 'Board';
    case 'calendarSurface': return 'Calendar';
    case 'timelineSurface': return 'Timeline';
    case 'gallerySurface': return 'Gallery';
    case 'overviewSurface': return 'Front page';
    case 'recordCommand': return 'Command';
    default: return 'Surfaces';
  }
}

export function surfaceCard(kind: string, title: string, id: string, detail: string): string {
  const glyph: Record<string, IconName> = { form: 'formSurface', list: 'listSurface', board: 'boardSurface', command: 'command' };
  return `<article class="surface-card">
    <span class="surface-icon" data-surface-kind="${escapeAttribute(kind.toLowerCase())}" aria-hidden="true">${icon(glyph[kind.toLowerCase()] ?? 'surfaces')}</span>
    <div class="surface-detail"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p><code>${escapeHtml(id)}</code></div>
    <span class="health-chip healthy">${icon('check')}Healthy</span>
  </article>`;
}

export function diagnosticsMarkup(result: CompileResult | null): string {
  const diagnostics = result?.diagnostics ?? [];
  if (diagnostics.length === 0) {
    return '<section class="empty-inline"><h3>No surfaces yet</h3><p>Ask an agent to propose a form, list, board or action for your records. Review it here before using it.</p></section>';
  }
  return `<section class="diagnostics"><h3>Custom surfaces are unavailable</h3><p>Data remains available while you resolve the definition.</p>${diagnostics.map((item) => `<article><strong>${escapeHtml(item.message)}</strong><p>${escapeHtml(item.hint)}</p><code>${escapeHtml(item.code)}</code></article>`).join('')}</section>`;
}

