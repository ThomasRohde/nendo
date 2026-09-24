import { refreshDerived, runMutation, openWorkspaceView } from './actions';
import { accumulatedWindows, boardColumns, calendarModes, calendarMonths, leaveRecordContext, matrixCells, selectedSurfaces, state, surfaceErrors, surfaceWindows, timelineModes, timelineYears, type CreateRelated } from './app-state';
import { type CalendarMode, shiftMonth } from './calendar-model';
import { client } from './client';
import { holdingThePage, refuseWhileDirty } from './draft-guard';
import { escapeAttribute, escapeHtml, messageFor, mutationKey } from './format';
import { WorkbenchHostError, type ApplicationPlan, type FieldPlan, type RecordPlan, type SurfaceNodePlan } from './host';
import { icon } from './icons';
import { inspectorMarkup, pageFormBody, pageHasTabs } from './page-markup';
import { drillIntoCell, matrixPending, refreshVisibleTiles, wireCharts, wireSummaryRetry } from './panels';
import { renderOverview, showsOverview } from './view-overview';
import { overviewTitle } from './overview-model';
import { createReadChase } from './read-chase';
import { activePlan, applicationPlans, overviewPlan, calendarKeyFor, calendarModeFor, calendarMonthFor, chartPending, formFields, referenceColumnsOf, selectedBoard, selectedSurfaceNode, tilePending, timelineKeyFor, timelineModeFor, timelineYearFor, visibleCharts, visibleTiles } from './plan-selection';
import { loadCalendarPage, loadRelatedWindows, loadSurfaceWindow, loadTimelinePage, relatedWindowsPending, wireRecordPager } from './reads';
import {
  closeRelatedCreate, recordInView, relatedTargetPlan, returnFromRelatedRecord, seedRelatedReference, wireRelatedActions,
} from './related-actions';
import { closeInspector, executeTreeCommand, wireRecordForm, wireRelatedPager } from './record-form';
import { fieldMarkup, recordFormMarkup } from './record-markup';
import { content, focusWithoutInteraction, requiredElement, rerender, setBusy, showError } from './shell';
import { drillPillMarkup, recordPagerMarkup, surfaceBodyMarkup, surfaceSelectorMarkup, surfaceTileMarkup } from './surface-markup';
import { type BoardView, accumulatesPages, surfaceById } from './surface-model';
import { renderSurfaces } from './view-surfaces';
/**
 * The Use view: one selected surface for one record type, the record opened
 * beside it, and the gestures that move a card between board columns.
 *
 * Only the selected surface is read. An unselected one keeps whatever window it
 * already had and is loaded when it is chosen.
 */

/**
 * Move to another surface of the same record type. Each surface declares its own
 * query, so this is a targeted read of that surface's first page and nothing
 * else: reloading the whole derived view would refetch history and agent status
 * for a change of view.
 */
export async function selectSurface(surfaceId: string): Promise<void> {
  const plan = activePlan();
  if (plan === null || state.actionInFlight) return;
  const entityId = plan.entity.semanticId;
  if (selectedSurfaces.get(entityId) === surfaceId) return;
  const node = surfaceById(plan, surfaceId);
  if (node === null) return;
  // Before the selection moves: the record beside the surface is left and the page
  // redrawn, which is the record's unsaved typing gone without a word (W-049).
  if (refuseWhileDirty('choosing another screen')) return;
  selectedSurfaces.set(entityId, surfaceId);
  leaveRecordContext();
  surfaceErrors.delete(surfaceId);
  // A calendar or a timeline reads its own pages when it renders, keyed by the
  // range and mode in view.
  if (accumulatesPages(node.kind)) { rerender(); return; }
  // A window loaded earlier in this revision is still the answer, so returning
  // to a surface does not re-read it.
  if (surfaceWindows.get(surfaceId)?.page.changeSequence === state.session.manifest?.changeSequence) { rerender(); return; }
  state.actionInFlight = true;
  setBusy(true);
  try {
    await loadSurfaceWindow(entityId, node);
  } catch (error) {
    surfaceErrors.set(surfaceId, messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
    rerender();
  }
}

/** One surface's first page, under the query that surface declares. */
/** The selected surface's chase, bounded the way the front page's is. */
const surfaceChase = createReadChase();
/**
 * The relations of the record page in view, chased on the same terms.
 *
 * A relation goes stale for reasons that are not a click — a record added to it from the
 * page itself, an agent writing to the record type it reads — so a draw that finds one
 * unread asks for it. Separate from the surface's chase because the two answer different
 * questions and a failure in one should not hold the other's interval.
 */
const relationChase = createReadChase();

/**
 * The reference back at the record a relation belongs to, which the related type's own
 * record page need not bind — and usually does not.
 *
 * A child's page shows what the child is; the relation is how the link is normally looked
 * at, from the other end. So the page that becomes this create form frequently has no
 * control for the field being filled in, and a form that wired only what the page binds
 * would submit a record pointing at nothing while the header said who it was for. It is
 * added where the page leaves it out, and is the first thing on the form: what the new
 * record belongs to is the reason the form is open.
 */
function relatedCreateVia(target: ApplicationPlan, viaFieldId: string): FieldPlan | null {
  return formFields(target).some((field) => field.semanticId === viaFieldId)
    ? null
    : target.entity.fields.find((field) => field.semanticId === viaFieldId) ?? null;
}

/** The fields the create form wires: the page's own, plus the reference back where it has none. */
function relatedCreateFields(target: ApplicationPlan, viaFieldId: string): FieldPlan[] {
  const via = relatedCreateVia(target, viaFieldId);
  return via === null ? formFields(target) : [via, ...formFields(target)];
}

/**
 * The form for a record being added from a related list (ADR-0004, 2026-09-18 amendment).
 *
 * It is the related type's own record page rendered as a create form, in the pane the
 * record page was in, so every rule that page already carries — its sections, its tabs, its
 * required fields — applies here without being restated. The seed record carries one value,
 * the reference back, so the control is drawn with it already chosen; `wireRecordForm` is
 * still told there is no record, so the save is a create.
 * <p>
 * `withRecordScoped` is false, as it is for every create form, so this form shows no
 * relations of its own: a record that does not exist has nothing pointing at it, and an Add
 * cannot nest.
 */
function relatedCreateInspector(created: CreateRelated, target: ApplicationPlan): string {
  const name = target.entity.displayName;
  const seed: RecordPlan = {
    semanticId: '',
    automationTarget: '',
    version: 0,
    values: { [created.viaFieldId]: created.parentRecordId },
  };
  const via = relatedCreateVia(target, created.viaFieldId);
  const body = `${via === null ? '' : `<div class="related-parent">${fieldMarkup(seed, via)}</div>`}${pageFormBody(target, seed, false)}`;
  return `<aside class="record-inspector" data-testid="related-create"><header><span>New ${escapeHtml(name)} for ${escapeHtml(created.parentLabel)}</span><button id="close-inspector" class="icon-button" type="button" aria-label="Close" data-dismiss>${icon('close')}</button></header>${recordFormMarkup(null, relatedCreateFields(target, created.viaFieldId), `Add ${name}`, body, '', pageHasTabs(target))}</aside>`;
}

export function renderUse(): void {
  // The front page is not one of a record type's surfaces, so it is chosen here
  // rather than in the surface picker. A file without one never reaches this.
  const overview = overviewPlan();
  if (overview !== null && showsOverview()) { renderOverview(overview); return; }
  const plan = activePlan();
  if (plan === null) {
    if (overview !== null) { state.showOverview = true; renderOverview(overview); return; }
    state.view = 'surfaces';
    renderSurfaces();
    return;
  }
  // A record opened from a related row was read on its own, so it need not be in the
  // window the surface behind it has loaded.
  const selected = recordInView(plan);
  // A record being added from a related list belongs to another record type, so its form is
  // built from that type's plan while the surface behind it stays where it was.
  const created = state.createRelated;
  const relatedTarget = created === null ? null : relatedTargetPlan(created.targetEntityId);
  const surface = selectedSurfaceNode(plan);
  const board = selectedBoard(plan);
  const entityName = plan.entity.displayName;
  const restorePickerFocus = document.activeElement?.matches('.surface-picker summary') ?? false;
  content.innerHTML = `<div class="use-page" data-testid="semantic-application">
    <header class="use-toolbar"><div class="toolbar-group"><label class="select-field">${overview === null ? 'Record type' : 'Showing'}<select id="use-entity">${overview === null ? '' : `<option value="">${escapeHtml(overviewTitle(overview))}</option>`}${applicationPlans().map(app => `<option value="${escapeAttribute(app.entity.semanticId)}" ${app.entity.semanticId === plan.entity.semanticId ? 'selected' : ''}>${escapeHtml(app.entity.displayName)}</option>`).join('')}</select></label>${surfaceSelectorMarkup(plan)}${drillPillMarkup(plan)}${state.returnTo === null ? '' : `<button id="related-back" class="text-button related-back" type="button"><span aria-hidden="true">←</span> Back to ${escapeHtml(state.returnTo.label)}</button>`}</div><div class="toolbar-group">${surface !== null && accumulatesPages(surface.kind) ? '' : recordPagerMarkup(plan.entity.semanticId, surface?.semanticId ?? null)}<button id="new-record" class="primary-button" data-action type="button"><span class="button-glyph" aria-hidden="true">+</span>Add ${escapeHtml(entityName)}</button></div></header>
    <div class="message-slot use-message" role="alert" hidden></div>
    <div class="use-layout ${selected !== null || state.creatingRecord || relatedTarget !== null ? 'has-inspector' : ''}">
      <section class="use-surface${surface?.kind === 'calendarSurface' ? ' calendar-surface' : surface?.kind === 'timelineSurface' ? ' timeline-surface' : surface?.kind === 'gallerySurface' ? ' gallery-surface' : surface?.kind === 'matrixSurface' ? ' matrix-surface' : ''}"${surface === null ? '' : ` data-surface="${escapeAttribute(surface.semanticId)}"`}>${surfaceTileMarkup(plan)}${surfaceBodyMarkup(plan)}</section>
      ${created !== null && relatedTarget !== null ? relatedCreateInspector(created, relatedTarget)
        : state.creatingRecord ? `<aside class="record-inspector"><header><span>New ${escapeHtml(entityName)}</span><button id="close-inspector" class="icon-button" type="button" aria-label="Close" data-dismiss>${icon('close')}</button></header>${recordFormMarkup(null, formFields(plan), `Add ${entityName}`, pageFormBody(plan, null, false), '', pageHasTabs(plan))}</aside>` : selected !== null ? inspectorMarkup(plan, selected) : ''}
    </div>
  </div>`;
  if (restorePickerFocus) focusWithoutInteraction(content.querySelector<HTMLElement>('.surface-picker summary'));
  requiredElement<HTMLSelectElement>('#use-entity').addEventListener('change', event => {
    const picker = event.currentTarget as HTMLSelectElement;
    const chosen = picker.value;
    // The picker has already moved by the time this hears about it, so declining puts
    // it back to the record type whose page is still holding the typing.
    if (refuseWhileDirty(chosen === '' ? 'opening the front page' : 'showing another record type')) {
      picker.value = plan.entity.semanticId;
      return;
    }
    if (chosen === '') {
      state.showOverview = true;
      leaveRecordContext();
      rerender();
      return;
    }
    state.selectedApplicationEntity = chosen;
    leaveRecordContext();
    void (async () => { await refreshDerived(); rerender(); })().catch(error => showError(messageFor(error)));
  });
  const picker = content.querySelector<HTMLDetailsElement>('.surface-picker');
  picker?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { picker.open = false; picker.querySelector('summary')?.focus(); }
  });
  picker?.addEventListener('focusout', () => {
    setTimeout(() => { if (!picker.contains(document.activeElement)) picker.open = false; }, 0);
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-select-surface]'))
    button.addEventListener('click', () => {
      if (picker !== null) picker.open = false;
      void selectSurface(button.dataset.selectSurface!).then(() => {
        focusWithoutInteraction(content.querySelector<HTMLElement>('.surface-picker summary'));
      });
    });
  // Every retry below redraws when its read lands, so each declines while the record
  // page beside the surface holds unsaved typing.
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-retry-columns]'))
    button.addEventListener('click', () => {
      if (state.actionInFlight || refuseWhileDirty('reading again')) return;
      boardColumns.delete(button.dataset.retryColumns!);
      void refreshVisibleTiles(plan).then(rerender).catch(error => showError(messageFor(error)));
    });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-retry-surface]'))
    button.addEventListener('click', () => {
      if (refuseWhileDirty('reading again')) return;
      const surfaceId = button.dataset.retrySurface!;
      surfaceErrors.delete(surfaceId);
      surfaceWindows.delete(surfaceId);
      const node = surfaceById(plan, surfaceId);
      if (node === null || state.actionInFlight) { rerender(); return; }
      state.actionInFlight = true; setBusy(true);
      void loadSurfaceWindow(plan.entity.semanticId, node)
        .catch(error => surfaceErrors.set(surfaceId, messageFor(error)))
        .finally(() => { state.actionInFlight = false; setBusy(false); rerender(); });
    });
  wireRecordPager();
  if (surface?.kind === 'extensionGraphSurface') wireExtensionSurface(surface);
  content.querySelector<HTMLButtonElement>('#related-back')?.addEventListener('click', () => void returnFromRelatedRecord());
  // Adding a record of the type in view abandons whatever record context there was,
  // including a related record half filled in and the way back to somewhere else — so
  // not while that context is holding unsaved typing.
  requiredElement<HTMLButtonElement>('#new-record').addEventListener('click', () => {
    if (refuseWhileDirty('adding a record')) return;
    leaveRecordContext(); state.creatingRecord = true; rerender();
  });
  for (const card of content.querySelectorAll<HTMLButtonElement>('[data-record-id]')) {
    // Selecting a record only says which record is open. Its relations and its totals are
    // read by the chases below, which is also what reads them when neither a click nor a
    // tab change is what made them stale.
    card.addEventListener('click', () => {
      if (refuseWhileDirty('opening another record')) return;
      state.selectedRecordId = card.dataset.recordId ?? null;
      state.creatingRecord = false;
      state.returnTo = null;
      rerender();
    });
  }
  wireSummaryRetry(plan);
  wireCharts(plan);
  if (surface?.kind === 'matrixSurface') wireMatrix(plan, surface);
  // The tiles for the selected surface are read on open, and only for the surface
  // in view: an unselected one is not fetched at all. This used to say that a tile
  // in flight is not pending, so it could not loop on itself. It can: a read the
  // file moves under is discarded and its in-flight mark removed, which makes the
  // tile pending again, and the redraw starts the next one. Bounded here instead.
  // Both chases redraw when their reads land, so both wait on the person's hold on the
  // page and on their unsaved typing, for the reason draft-guard.ts gives.
  if (visibleTiles(plan).some(tilePending) || visibleCharts(plan).some(chartPending) || matrixPending(plan))
    surfaceChase.run(() => refreshVisibleTiles(plan), rerender, error => showError(messageFor(error)), holdingThePage);
  if (selected !== null && relatedWindowsPending(plan, selected.semanticId)) {
    const recordId = selected.semanticId;
    relationChase.run(() => loadRelatedWindows(plan, recordId), rerender,
      error => showError(messageFor(error)), holdingThePage);
  }
  if (surface?.kind === 'calendarSurface') wireCalendar(plan, surface);
  if (surface?.kind === 'timelineSurface') wireTimeline(plan, surface);
  if (surface !== null && board !== null) wireBoardDrag(plan, surface, board);
  if (created !== null && relatedTarget !== null) {
    wireRecordForm(null, created.targetEntityId, relatedCreateFields(relatedTarget, created.viaFieldId), closeRelatedCreate, relatedTarget);
    seedRelatedReference(created);
  } else if (state.creatingRecord) {
    wireRecordForm(null, plan.entity.semanticId, formFields(plan), closeInspector, plan);
  } else if (selected !== null) {
    wireRecordForm(selected, plan.entity.semanticId, formFields(plan), closeInspector, plan);
    wireRelatedActions(plan, selected);
    wireRelatedPager(plan, selected);
    for (const button of content.querySelectorAll<HTMLButtonElement>('[data-run-command]'))
      button.addEventListener('click', () => void executeTreeCommand(plan, selected, button.dataset.runCommand!, button.textContent ?? 'Command'));
  }
}

function wireExtensionSurface(surface: SurfaceNodePlan): void {
  const status = requiredElement<HTMLElement>('#extension-status');
  const next = requiredElement<HTMLButtonElement>('#extension-next');
  const generation = state.session.fileSessionId;
  // One next step at a time, in the order the design requires: the package on this device,
  // permission for this view, then the graph. Four buttons at once lost the owner.
  let step: 'install' | 'allow' | 'open' | null = null;
  const refresh = async (): Promise<void> => {
    try {
      const view = await client.request<{ packageState: string; isApproved: boolean;
        definition: { packageId: string; packageVersion: string }; notice: string | null }>('extension.status', { viewId: surface.semanticId });
      if (!status.isConnected || state.session.fileSessionId !== generation) return;
      const packageName = view.definition.packageId + ' ' + view.definition.packageVersion;
      if (view.packageState !== 'available') {
        step = 'install'; next.textContent = 'Install package…';
        status.textContent = view.packageState === 'missing'
          ? packageName + ' is not on this device yet. Install it from its .nendoview file, then allow this view.'
          : view.packageState === 'incompatible'
            // The bytes are intact; the view and the package disagree about the protocol,
            // which only a change to the view's pin can settle.
            ? packageName + ' speaks a different protocol than this view. Pin a package built for this view in Studio; your records are unchanged.'
            : packageName + ' is ' + view.packageState + ' on this device. Install the exact package again from its .nendoview file.';
      } else if (!view.isApproved) {
        step = 'allow'; next.textContent = 'Allow this view';
        status.textContent = packageName + ' is installed. Allow this view to read the fields it names, then open it.';
      } else {
        step = 'open'; next.textContent = 'Open graph';
        status.textContent = packageName + ' is installed and allowed on this device. The graph opens beside your records.';
      }
      if (view.notice) status.textContent += ' ' + view.notice;
      next.dataset.step = step; next.disabled = false;
    } catch (error) {
      if (status.isConnected && state.session.fileSessionId === generation) {
        step = null; next.disabled = true; next.textContent = 'Unavailable';
        status.textContent = messageFor(error) + ' Your records remain available in Studio.';
      }
    }
  };
  const run = async (method: string): Promise<void> => {
    if (state.actionInFlight || refuseWhileDirty('opening a custom view')) return;
    state.actionInFlight = true; setBusy(true);
    try { await client.request(method, { viewId: surface.semanticId }); }
    catch (error) { showError(messageFor(error)); }
    finally { state.actionInFlight = false; setBusy(false); await refresh(); }
  };
  next.addEventListener('click', () => {
    if (step === 'install') void run('extension.install');
    else if (step === 'allow') void run('extension.review');
    else if (step === 'open') void run('extension.open');
  });
  requiredElement<HTMLButtonElement>('#manage-extension').addEventListener('click', () => { void run('file.customViews'); });
  requiredElement<HTMLButtonElement>('#extension-studio').addEventListener('click', () => { void openWorkspaceView('data'); });
  void refresh();
}

/**
 * A matrix's own two controls: retry its count, and drill from a cell.
 *
 * A cell drills with two predicates — its row and its column — which is why it is not the
 * chart drill: that one applies a single group's predicate. Both are transient renderer
 * state and neither reaches the file.
 */
export function wireMatrix(plan: ApplicationPlan, surface: SurfaceNodePlan): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-retry-matrix]'))
    button.addEventListener('click', () => {
      if (state.actionInFlight || refuseWhileDirty('reading again')) return;
      matrixCells.delete(button.dataset.retryMatrix!);
      void refreshVisibleTiles(plan).then(rerender).catch(error => showError(messageFor(error)));
    });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-matrix-drill]'))
    button.addEventListener('click', () => {
      if (state.actionInFlight || refuseWhileDirty('narrowing the list')) return;
      const row = button.dataset.matrixRowUnset === 'true' ? null : button.dataset.matrixRow ?? '';
      const column = button.dataset.matrixColumnUnset === 'true' ? null : button.dataset.matrixColumn ?? '';
      const label = button.closest('.matrix-cell')?.querySelector('.matrix-total')?.getAttribute('aria-label') ?? 'this cell';
      void drillIntoCell(plan, surface, row, column, label.replace(/^\d+ with /, ''))
        .catch(error => showError(messageFor(error)));
    });
}

export function wireBoardDrag(plan: ApplicationPlan, node: SurfaceNodePlan, board: BoardView): void {
  const fileSessionId = state.session.fileSessionId;
  const surfaceId = node.semanticId;
  const boardLanes = referenceColumnsOf(node) ?? [];
  let gesture: { record: RecordPlan; card: HTMLButtonElement; pointerId: number; x: number; y: number; active: boolean } | null = null;
  let formDirty = false;
  const form = content.querySelector('#record-form');
  form?.addEventListener('input', () => { formDirty = true; });
  form?.addEventListener('change', () => { formDirty = true; });
  const columns = [...content.querySelectorAll<HTMLElement>('.board-column')];
  const clear = (): void => {
    const previous = gesture;
    gesture = null;
    if (previous?.card.hasPointerCapture(previous.pointerId)) previous.card.releasePointerCapture(previous.pointerId);
    for (const column of columns) column.classList.remove('drop-target');
    content.querySelector('.is-dragging')?.classList.remove('is-dragging');
  };
  const writable = (): boolean => {
    if (state.actionInFlight || state.session.health !== 'normal' || state.session.fileSessionId !== fileSessionId) return false;
    try { return client.pendingMutation?.()?.state !== 'pending'; } catch { return false; }
  };
  const targetAt = (event: PointerEvent): HTMLElement | undefined => {
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest('.board-column');
    return columns.find((column) => column === element);
  };
  for (const card of content.querySelectorAll<HTMLButtonElement>('.record-card')) {
    // Native HTML drag events do not complete reliably in WinUI WebView2.
    // Pointer capture keeps this gesture within the current board and file session.
    card.draggable = false;
    card.classList.add('can-drag');
    let suppressClick = false;
    card.addEventListener('click', (event) => {
      if (suppressClick && event.detail !== 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
      }
    }, true);
    card.addEventListener('dragstart', (event) => event.preventDefault());
    card.addEventListener('pointerdown', (event) => {
      suppressClick = false;
      if (!event.isPrimary || event.button !== 0 || !writable()) return;
      const record = plan.records.find((item) => item.semanticId === card.dataset.recordId);
      if (!record) return;
      gesture = { record, card, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener('pointermove', (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (!writable() || event.buttons === 0) { clear(); return; }
      if (!gesture.active) {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return;
        suppressClick = true;
        if (formDirty) {
          clear();
          showError('Save your changes or close record details before moving a card.');
          return;
        }
        gesture.active = true;
        card.classList.add('is-dragging');
      }
      event.preventDefault();
      const target = targetAt(event);
      for (const column of columns) column.classList.toggle('drop-target', column === target && column.dataset.group !== undefined &&
        board.groups.includes(column.dataset.group) &&
        gesture.record.values[board.groupByFieldId] !== column.dataset.group);
    });
    card.addEventListener('pointerup', (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const { record, active } = gesture;
      const group = targetAt(event)?.dataset.group;
      const admitted = active && writable() && !formDirty && group !== undefined && board.groups.includes(group);
      clear();
      if (!admitted || group === undefined) return;
      event.preventDefault();
      if (record.values[board.groupByFieldId] === group) return;
      // A reference write is refused without the target record's current version, where a
      // choice literal needs none. The board read the target type to draw its columns at
      // all, so it is carrying the answer; a column whose version it does not have is not
      // a column it drew, and the drop is declined rather than sent to be refused.
      const column = board.reference === null ? null : boardLanes.find((item) => item.recordId === group);
      if (board.reference !== null && column === undefined) {
        showError('This column could not be identified. Reload the board and try again.');
        return;
      }
      void runMutation('data.setField', {
        entityId: plan.entity.semanticId, recordId: record.semanticId,
        expectedRecordVersion: record.version, fieldId: board.groupByFieldId,
        value: group, idempotencyKey: mutationKey(),
        ...(column === null || column === undefined ? {} : { expectedTargetRecordVersion: column.version }),
      }, `Moved to ${column?.label ?? group}.`, true, undefined, (error) => {
        // The host says to select the target again, because everywhere else a reference is
        // written there is a picker to select it in. On a board there is not: the column is
        // the target, and the remedy is that the board reads its columns again.
        if (!(error instanceof WorkbenchHostError) || error.code !== 'target-version-conflict') return null;
        boardColumns.delete(surfaceId);
        return `${column?.label ?? 'That column'} changed while this board was open, so the card was not moved. The columns have been read again — try the move once more.`;
      });
    });
    card.addEventListener('pointercancel', clear);
    card.addEventListener('lostpointercapture', clear);
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || gesture === null) return;
      event.stopPropagation();
      clear();
    });
  }
}

export function wireCalendar(plan: ApplicationPlan, node: SurfaceNodePlan): void {
  const surfaceId = node.semanticId;
  const reload = (): void => {
    if (state.actionInFlight || refuseWhileDirty('reading the calendar again')) return;
    state.actionInFlight = true;
    setBusy(true);
    void loadCalendarPage(plan, node, false)
      .catch(() => { /* the failure is recorded on the accumulator */ })
      .finally(() => { state.actionInFlight = false; setBusy(false); rerender(); });
  };
  // Every move of the calendar leaves the record beside it and redraws, so each declines
  // while that record holds unsaved typing — before the month changes and the record
  // context is left, or the refusal would follow the loss it exists to prevent.
  const move = (change: () => void): void => {
    if (refuseWhileDirty('moving the calendar')) return;
    change();
    leaveRecordContext();
    reload();
  };
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-calendar-month]'))
    button.addEventListener('click', () => move(() => {
      calendarMonths.set(surfaceId, shiftMonth(calendarMonthFor(surfaceId), Number(button.dataset.calendarMonth)));
    }));
  content.querySelector<HTMLButtonElement>('[data-calendar-today]')?.addEventListener('click', () => move(() => {
    calendarMonths.delete(surfaceId);
  }));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-calendar-mode]'))
    button.addEventListener('click', () => {
      const mode = button.dataset.calendarMode as CalendarMode;
      if (calendarModeFor(surfaceId) === mode) return;
      move(() => { calendarModes.set(surfaceId, mode); });
    });
  content.querySelector<HTMLButtonElement>('[data-calendar-retry]')?.addEventListener('click', reload);
  content.querySelector<HTMLButtonElement>('[data-calendar-more]')?.addEventListener('click', () => {
    if (state.actionInFlight || refuseWhileDirty('loading more of the calendar')) return;
    state.actionInFlight = true;
    setBusy(true);
    void loadCalendarPage(plan, node, true)
      .catch(() => { /* the failure is recorded on the accumulator */ })
      .finally(() => { state.actionInFlight = false; setBusy(false); rerender(); });
  });
  // The first open of a month reads its first page.
  const accumulated = accumulatedWindows.get(calendarKeyFor(node));
  if (accumulated === undefined || accumulated.changeSequence !== state.session.manifest?.changeSequence) reload();
}

/**
 * The timeline's controls, in the calendar's shape: a year instead of a month,
 * This year instead of Today, and the same undated view, retry and Load more.
 */
export function wireTimeline(plan: ApplicationPlan, node: SurfaceNodePlan): void {
  const surfaceId = node.semanticId;
  const read = (append: boolean): void => {
    if (state.actionInFlight || refuseWhileDirty(append ? 'loading more of the timeline' : 'reading the timeline again')) return;
    state.actionInFlight = true;
    setBusy(true);
    void loadTimelinePage(plan, node, append)
      .catch(() => { /* the failure is recorded on the accumulator */ })
      .finally(() => { state.actionInFlight = false; setBusy(false); rerender(); });
  };
  const reload = (): void => read(false);
  // As the calendar's moves decline: before the year changes and the record is left.
  const move = (change: () => void): void => {
    if (refuseWhileDirty('moving the timeline')) return;
    change();
    leaveRecordContext();
    reload();
  };
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-timeline-year]'))
    button.addEventListener('click', () => move(() => {
      timelineYears.set(surfaceId, timelineYearFor(surfaceId) + Number(button.dataset.timelineYear));
    }));
  content.querySelector<HTMLButtonElement>('[data-timeline-this-year]')?.addEventListener('click', () => move(() => {
    timelineYears.delete(surfaceId);
  }));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-timeline-mode]'))
    button.addEventListener('click', () => {
      const mode = button.dataset.timelineMode as CalendarMode;
      if (timelineModeFor(surfaceId) === mode) return;
      move(() => { timelineModes.set(surfaceId, mode); });
    });
  content.querySelector<HTMLButtonElement>('[data-timeline-retry]')?.addEventListener('click', reload);
  content.querySelector<HTMLButtonElement>('[data-timeline-more]')?.addEventListener('click', () => read(true));
  // The first open of a year reads its first page.
  const accumulated = accumulatedWindows.get(timelineKeyFor(node));
  if (accumulated === undefined || accumulated.changeSequence !== state.session.manifest?.changeSequence) reload();
}
