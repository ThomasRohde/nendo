import { state } from './app-state';
import { escapeAttribute, escapeHtml, fieldName } from './format';
import { type ApplicationPlan, type CompilerDiagnostic, type ExtensionRuntimeView, type SurfaceNodePlan } from './host';
import { type IconName, icon } from './icons';
import { descendants, kindLabel } from './surface-model';

// The Surfaces catalogue's cards, in a module of their own so a test can draw one without a page.
// Contract version 3 roots are described from the compiled tree rather than from the version 1
// and 2 slots, which a version 3 plan leaves empty.

/** What a card says about its root's health, beyond compiling: the compiler's warnings and whether a custom view can run. */
export interface SurfaceCardContext {
  /** The compile's warnings, each naming the node it is about. */
  warnings: readonly CompilerDiagnostic[];
  /** Whether views run here and the packages the file carries; absent before the host says. */
  extensions?: ExtensionRuntimeView | null;
}

/** A card's chip: Healthy, or what stands in the way, with the sentence that says why. */
export interface SurfaceHealth { tone: 'healthy' | 'warning'; label: string; message: string | null }

const healthy: SurfaceHealth = { tone: 'healthy', label: 'Healthy', message: null };

/** Whether a diagnostic is a warning: the host sends the severity by name or by its number. */
export function isWarning(diagnostic: Pick<CompilerDiagnostic, 'severity'>): boolean {
  return diagnostic.severity === 'warning' || diagnostic.severity === 1;
}

/**
 * A root's health as the person should read it. A definition that compiles can still carry a
 * warning, such as a view naming a package the file lacks (NUI452), and a custom view does not
 * run while views are off. Every card read "Healthy" whatever the compiler or the switches
 * said, while Use showed the missing notice.
 */
export function surfaceHealth(root: SurfaceNodePlan, context: SurfaceCardContext | undefined): SurfaceHealth {
  if (context === undefined) return healthy;
  const ids = new Set([root.semanticId, ...allNodes(root.children).map((node) => node.semanticId)]);
  const warning = context.warnings.find((item) => isWarning(item) && item.semanticId !== null && ids.has(item.semanticId));
  const packageId = typeof root.properties.packageId === 'string' ? root.properties.packageId : null;
  const extensions = context.extensions;
  if (packageId !== null && extensions != null && !extensions.packages.some((pkg) => pkg.packageId === packageId))
    return { tone: 'warning', label: 'Missing package', message: warning?.message ?? `The package ${packageId} is not in this file, so the view has no code to run yet.` };
  if (warning !== undefined) return { tone: 'warning', label: 'Warning', message: warning.message };
  if (packageId !== null && extensions != null && !extensions.run)
    return { tone: 'warning', label: 'Off', message: 'Custom views are off, so this view does not run. Custom views below says why.' };
  return healthy;
}

function allNodes(nodes: readonly SurfaceNodePlan[]): SurfaceNodePlan[] {
  return nodes.flatMap((node) => [node, ...allNodes(node.children)]);
}

/** A root's name as Use names it: its title, else an action's label, else its record type. */
export function rootTitle(plan: ApplicationPlan, root: SurfaceNodePlan): string {
  for (const key of ['title', 'label'] as const) {
    const value = root.properties[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return plan.entity.displayName;
}

export function treeSurfaceCard(plan: ApplicationPlan, root: SurfaceNodePlan, context?: SurfaceCardContext): string {
  const title = rootTitle(plan, root);
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
    case 'recordCommand': {
      parts.push('Action');
      // A contract version 3 action keeps what it sets on its steps, one field each.
      const fields = [...new Set(descendants(root.children, 'commandStep')
        .map((step) => step.properties.fieldId)
        .filter((fieldId): fieldId is string => typeof fieldId === 'string')
        .map((fieldId) => fieldName(plan, fieldId)))];
      if (fields.length > 0) parts.push(`sets ${fields.join(', ')}`);
      break;
    }
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
      // Named as a person reads it, never by the stored kind.
      parts.push(kindLabel(root.kind));
      break;
  }
  return surfaceCard(cardKindFor(root.kind), title, root.semanticId, parts.join(' · '), surfaceHealth(root, context),
    root.kind === 'boardSurface' ? boardRenameMarkup(root) : '');
}

/**
 * Renaming a board, on the board's own card and addressed by its node. One form under
 * the list renamed only the type's first board, and nothing said which board it was.
 */
export function boardRenameMarkup(root: SurfaceNodePlan): string {
  const title = typeof root.properties.title === 'string' ? root.properties.title : null;
  if (title === null) return '';
  const token = root.semanticId.replace(/[^A-Za-z0-9_-]/g, '-');
  return `<form class="board-rename" data-board-rename="${escapeAttribute(root.semanticId)}"><label for="board-title-${escapeAttribute(token)}">Rename this board</label><input id="board-title-${escapeAttribute(token)}" data-board-title maxlength="120" required value="${escapeAttribute(title)}" aria-describedby="surface-title-${escapeAttribute(token)}" /><button class="secondary-button" data-action type="submit">Preview rename</button></form>`;
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
    default: return 'Screens';
  }
}

export function surfaceCard(kind: string, title: string, id: string, detail: string, health: SurfaceHealth = healthy, extra = ''): string {
  const glyph: Record<string, IconName> = { form: 'formSurface', list: 'listSurface', board: 'boardSurface', command: 'command' };
  const token = id.replace(/[^A-Za-z0-9_-]/g, '-');
  return `<article class="surface-card" data-surface-health="${health.tone}">
    <span class="surface-icon" data-surface-kind="${escapeAttribute(kind.toLowerCase())}" aria-hidden="true">${icon(glyph[kind.toLowerCase()] ?? 'surfaces')}</span>
    <div class="surface-detail"><h3 id="surface-title-${escapeAttribute(token)}">${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p>${health.message === null ? '' : `<p class="surface-warning">${escapeHtml(health.message)}</p>`}<code>${escapeHtml(id)}</code></div>
    <span class="health-chip ${health.tone}">${icon(health.tone === 'healthy' ? 'check' : 'alert')}${escapeHtml(health.label)}</span>
    ${extra}
  </article>`;
}
