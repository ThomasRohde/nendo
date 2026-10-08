import { leaveRecordContext, state } from './app-state';
import { escapeAttribute, escapeHtml } from './format';
import type { CompileResult, ExtensionRuntimeView, SurfaceNodePlan } from './host';
import type { IconName } from './icons';
import { overviewTitle } from './overview-model';
import { overviewPlan, placePlans } from './plan-selection';
import { rerender } from './shell';
import { viewTitle } from './view-frame-markup';
import { typeIcon } from './type-icons';

/**
 * The file's own views (ADR-0013 Phase 5, W-106): an `extensionView` root is a screen of the
 * file rather than of a record type. Use lists it in the breadcrumb's first picker, between the
 * front page and the record types, and draws it as one frame that fills the screen. One of them
 * may say the file opens on it; where custom views do not run, the file opens as if none did.
 */

/** The value a file view's option carries in the Showing picker; record types carry their ID, the front page ''. */
export const fileViewValue = 'view:';

/** The views of the file, in authored order, when the definition compiles. */
export function fileViews(): SurfaceNodePlan[] {
  return state.compilation?.isValid ? state.compilation.views ?? [] : [];
}

export function fileViewById(viewId: string | null): SurfaceNodePlan | null {
  return viewId === null ? null : fileViews().find((view) => view.semanticId === viewId) ?? null;
}

/** Whether Use is showing one of the file's views: one is chosen, and the file still has it. */
export function showsFileView(): boolean {
  return fileViewById(state.fileView) !== null;
}

/**
 * The view a file opens on: the one that says opensFile, when the definition compiles and custom
 * views run in this file. Anything that keeps views from running — the device or file switch,
 * safe mode, a restart without them, the file's health — leaves the file opening as before.
 */
export function openingFileView(definition: CompileResult | null, extensions: ExtensionRuntimeView | null | undefined): string | null {
  if (definition?.isValid !== true || extensions?.run !== true) return null;
  return (definition.views ?? []).find((view) => view.properties.opensFile === true)?.semanticId ?? null;
}

/**
 * The options of the breadcrumb's first picker, the place Use is chosen (W-092): the front page,
 * then the file's views, then the record types that have a screen, with the one in view selected.
 */
export function showingOptionsMarkup(current: { overview: boolean; fileView: string | null; entityId: string | null }): string {
  const overview = overviewPlan();
  return (overview === null ? '' : `<option value="" ${current.overview ? 'selected' : ''}>${escapeHtml(overviewTitle(overview))}</option>`) +
    fileViews().map((view) => `<option value="${escapeAttribute(fileViewValue + view.semanticId)}" ${current.fileView === view.semanticId ? 'selected' : ''}>${escapeHtml(viewTitle(view))}</option>`).join('') +
    placePlans(current.entityId).map((app) => `<option value="${escapeAttribute(app.entity.semanticId)}" ${current.entityId === app.entity.semanticId ? 'selected' : ''}>${escapeHtml(app.entity.displayName)}</option>`).join('');
}

/**
 * A view's icon in the navigation, the address and its tab (W-184). The view the file opens on is
 * its home, as a front page is, when the file has no front page. Any other view's title is guessed
 * as a record type's name is, so Garden is a sprout; a title that suggests nothing keeps the panels.
 */
export function viewIcon(view: SurfaceNodePlan): IconName {
  if (view.properties.opensFile === true && overviewPlan() === null) return 'home';
  return typeIcon(viewTitle(view)) ?? 'surfaces';
}

/** What the first picker is called: Showing when it offers more than record types. */
export function showingLabel(): string {
  return overviewPlan() !== null || fileViews().length > 0 ? 'Showing' : 'Record type';
}

/** Show one of the file's views. */
export function showFileView(viewId: string): void {
  state.fileView = viewId;
  state.showOverview = false;
  leaveRecordContext();
  rerender();
}
