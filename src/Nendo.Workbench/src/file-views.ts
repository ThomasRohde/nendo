import { refreshDerived } from './actions';
import { leaveRecordContext, state } from './app-state';
import { refuseWhileDirty } from './draft-guard';
import { escapeAttribute, messageFor } from './format';
import type { SurfaceNodePlan } from './host';
import { icon } from './icons';
import { drawPlacePickers } from './place-pickers';
import { content, rerender, showError } from './shell';
import { viewPlaceholderMarkup, viewSpecFor } from './view-frame-markup';
import { viewAddCommand, wireViewFrames } from './view-frames';
import { fileViewValue, showFileView, showingLabel, showingOptionsMarkup } from './file-view-model';

/** The screen of one of the file's own views (W-106); what they are and how Use chooses one is in file-view-model.ts. */

/** Leave the file's view for the front page or a record type, as the picker says. */
function leaveFor(value: string): void {
  if (value.startsWith(fileViewValue)) { showFileView(value.slice(fileViewValue.length)); return; }
  state.fileView = null;
  leaveRecordContext();
  if (value === '') { state.showOverview = true; rerender(); return; }
  state.showOverview = false;
  state.selectedApplicationEntity = value;
  void (async () => { await refreshDerived(); rerender(); })().catch((error) => showError(messageFor(error)));
}

/**
 * One of the file's views, filling Use. Nendo draws the view's declared controls in the row under
 * the top bar (W-090), and its Add when the view names one; a view of the file has no record type
 * of its own to add to, so without one there is no Add.
 */
export function renderFileView(view: SurfaceNodePlan): void {
  const subject = typeof view.properties.entityId === 'string' ? view.properties.entityId : null;
  const pickers = drawPlacePickers(`<span class="place-root">Use</span><span class="place-dot" aria-hidden="true">·</span><label class="place-entity"><span class="visually-hidden">${showingLabel()}</span><select id="use-entity">${showingOptionsMarkup({ overview: false, fileView: view.semanticId, entityId: null })}</select><span class="place-chevron" aria-hidden="true">${icon('chevron')}</span></label>`);
  content.innerHTML = `<div class="use-page" data-testid="file-view">
    <header class="use-toolbar"><div class="view-toolbar-slot" data-view-toolbar-slot></div><div class="toolbar-group use-actions"><button id="new-record" class="primary-button" data-action data-file-view-add type="button" ${viewAddCommand() === null ? 'hidden' : ''}><span class="button-glyph" aria-hidden="true">+</span>Add</button></div></header>
    <div class="message-slot use-message" role="alert" hidden></div>
    <div class="use-layout"><section class="use-surface custom-view-surface" data-surface="${escapeAttribute(view.semanticId)}">${viewPlaceholderMarkup(viewSpecFor(view, 'screen', subject, null))}</section></div>
  </div>`;
  pickers.querySelector<HTMLSelectElement>('#use-entity')?.addEventListener('change', (event) => {
    const picker = event.currentTarget as HTMLSelectElement;
    if (refuseWhileDirty('showing another screen')) { picker.value = fileViewValue + view.semanticId; return; }
    leaveFor(picker.value);
  });
  content.querySelector<HTMLButtonElement>('#new-record')?.addEventListener('click', () => viewAddCommand()?.());
  wireViewFrames(content);
}
