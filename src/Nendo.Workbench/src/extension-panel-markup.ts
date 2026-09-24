import { escapeAttribute, escapeHtml } from './format';
import type { RecordPlan, SurfaceNodePlan } from './host';

/**
 * A custom view on a record page, as the page draws it (ADR-0013, 2026-09-24; W-061). Only
 * the placeholder is the page's; extension-panel.ts wires it, and the view itself runs in
 * the host's own window once the person asks for it. Kept apart from the wiring so that the
 * markup renders without a host.
 */
export const panelKind = 'extensionRecordPanel';

/**
 * The placeholder. A record that has not been saved has no ID for a view to be scoped to,
 * so it says so instead of offering a view that could not start.
 */
export function extensionPanelMarkup(node: SurfaceNodePlan, record: RecordPlan | null): string {
  const title = typeof node.properties.title === 'string' && node.properties.title.length > 0 ? node.properties.title : 'Custom view';
  const packageName = typeof node.properties.packageId === 'string' ? `${node.properties.packageId} ${String(node.properties.packageVersion ?? '')}`.trim() : 'A custom-view package';
  const titleId = `extension-panel-title-${escapeAttribute(node.semanticId)}`;
  if (record === null)
    return `<section class="extension-panel" data-extension-panel-unsaved aria-labelledby="${titleId}"><header><h3 id="${titleId}">${escapeHtml(title)}</h3><span class="extension-panel-package">${escapeHtml(packageName)}</span></header><p class="extension-panel-status">Save this record to show its custom view.</p></section>`;
  return `<section class="extension-panel" data-extension-panel="${escapeAttribute(node.semanticId)}" data-record="${escapeAttribute(record.semanticId)}" aria-labelledby="${titleId}"><header><h3 id="${titleId}">${escapeHtml(title)}</h3><span class="extension-panel-package">${escapeHtml(packageName)}</span></header><p class="extension-panel-status" role="status">Checking this view…</p><div class="extension-panel-actions"><button type="button" class="primary-button" data-panel-next disabled>Show view</button><button type="button" class="secondary-button" data-panel-stop hidden>Stop view</button></div><div class="extension-panel-viewport" data-panel-viewport hidden aria-label="${escapeAttribute(title)}, a custom view of this record"></div></section>`;
}

