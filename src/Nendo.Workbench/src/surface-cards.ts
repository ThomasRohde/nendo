import { state } from './app-state';
import { escapeAttribute, escapeHtml, fieldName } from './format';
import { type ApplicationPlan, type SurfaceNodePlan } from './host';
import { type IconName, icon } from './icons';
import { descendants, kindLabel } from './surface-model';

// The Surfaces catalogue's cards, in a module of their own so a test can draw one without a page.
// Contract version 3 roots are described from the compiled tree rather than from the version 1
// and 2 slots, which a version 3 plan leaves empty.

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
    case 'outlineSurface':
      parts.push('Outline', `${bindings} ${bindings === 1 ? 'column' : 'columns'} beside the title`);
      if (typeof root.properties.titleFieldId === 'string') parts.push(`titled by ${fieldName(plan, root.properties.titleFieldId)}`);
      if (root.properties.reorder === true) parts.push('records can be moved');
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
    case 'extensionGraphSurface':
    case 'extensionRecordsSurface':
      parts.push(root.kind === 'extensionGraphSurface' ? 'Custom graph' : 'Custom view');
      if (typeof root.properties.packageId === 'string') parts.push(`runs ${root.properties.packageId}`);
      break;
    case 'matrixSurface':
      parts.push('Matrix');
      if (typeof root.properties.rowByFieldId === 'string' && typeof root.properties.columnByFieldId === 'string')
        parts.push(`${fieldName(plan, root.properties.rowByFieldId)} by ${fieldName(plan, root.properties.columnByFieldId)}`);
      break;
    default:
      // Named as a person reads it, never by the stored kind (WMX-17).
      parts.push(kindLabel(root.kind));
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
    case 'outlineSurface': return 'Outline';
    case 'matrixSurface': return 'Matrix';
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
