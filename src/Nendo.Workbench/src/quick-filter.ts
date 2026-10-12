import { leaveRecordContext, matrixCells, quickFilters, quickFilterTargets, state, surfaceErrors, surfaceWindows } from './app-state';
import { client } from './client';
import { refuseWhileDirty } from './draft-guard';
import { messageFor } from './format';
import type { ApplicationPlan, FieldPlan, ReadPage, RecordSnapshot, SurfaceNodePlan } from './host';
import { icon } from './icons';
import {
  maximumQuickFilterTargets, offersQuickFilter, quickFilterFields, quickFilterFor, quickFilterMenuMarkup, quickFilterPillMarkup,
} from './quick-filter-model';
import { loadSurfaceWindow } from './reads';
import { windowRequest } from './record-window';
import { content, focusWithoutInteraction, rerender, setBusy } from './shell';

// The screen whose Filter menu is open, so a redraw while its targets are read keeps it open.
let openSurfaceId: string | null = null;

/** The pill for the screen in view, or nothing when it is not narrowed. */
export function quickFilterPill(surface: SurfaceNodePlan | null): string {
  return surface === null ? '' : quickFilterPillMarkup(quickFilters.get(surface.semanticId), icon('close'));
}

/** The Filter menu for the screen in view, or nothing when the screen offers none. */
export function quickFilterMenu(plan: ApplicationPlan, surface: SurfaceNodePlan | null): string {
  if (surface === null || !offersQuickFilter(surface, plan.entity.fields)) return '';
  return quickFilterMenuMarkup(plan.entity.fields, quickFilters.get(surface.semanticId),
    field => field.reference == null ? undefined : quickFilterTargets.get(field.reference.targetEntityId),
    openSurfaceId === surface.semanticId, icon('filter'));
}

export function wireQuickFilter(plan: ApplicationPlan, surface: SurfaceNodePlan | null): void {
  if (surface === null) return;
  const menu = content.querySelector<HTMLDetailsElement>('[data-testid="quick-filter"]');
  // Chromium fires toggle on a details inserted open. Only a change from what was drawn is
  // the person opening or closing it; otherwise each redraw read the targets and redrew the
  // menu open again, without end (WDV-01).
  let drawn = menu?.open ?? false;
  menu?.addEventListener('toggle', () => {
    if (menu.open === drawn) return;
    drawn = menu.open;
    openSurfaceId = menu.open ? surface.semanticId : null;
    if (menu.open) void readTargets(plan);
  });
  // A menu drawn open whose targets were never read, as after the file view was reset, reads
  // them once. readTargets marks them loading before it redraws, so that redraw reads nothing.
  if (menu?.open && quickFilterFields(plan.entity.fields).some(field =>
    field.reference != null && !quickFilterTargets.has(field.reference.targetEntityId)))
    queueMicrotask(() => void readTargets(plan));
  menu?.addEventListener('keydown', event => {
    // The menu's Escape is the menu's: the page's own Escape would also close the record (UIS-04).
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      // A value only looked at goes back, so leaving the select does not apply it.
      for (const select of menu.querySelectorAll<HTMLSelectElement>('[data-quick-filter]')) if (select.dataset.drawn !== undefined) select.value = select.dataset.drawn;
      menu.open = false; menu.querySelector('summary')?.focus();
    }
  });
  for (const select of content.querySelectorAll<HTMLSelectElement>('[data-quick-filter]')) {
    // Chromium on Windows changes a closed select's value on each arrow key and fires change at
    // once, so applying every change applied the first choice a keyboard user looked at, closed
    // the menu and dropped focus (UIK-07). A change made with the keys waits for Enter, or for
    // focus to leave the select; a pick from the open list applies as before.
    const drawn = select.value;
    select.dataset.drawn = drawn;
    let keyed = false;
    let applied = false;
    const apply = (): void => {
      if (applied || select.value === drawn) return;
      applied = true;
      const field = plan.entity.fields.find(candidate => candidate.semanticId === select.dataset.quickFilter);
      if (field === undefined) return;
      // Declined: draw the menu again from what is picked, which is still the previous pick.
      if (state.actionInFlight || refuseWhileDirty('narrowing the screen')) { rerender(); return; }
      const pick = quickFilterFor(field, select.value,
        field.reference == null ? undefined : quickFilterTargets.get(field.reference.targetEntityId));
      if (pick === null) quickFilters.delete(surface.semanticId); else quickFilters.set(surface.semanticId, pick);
      openSurfaceId = null;
      // The menu closes after a pick, and focus goes back to the Filter button it was opened from.
      void reopen(plan, surface).then(() => focusWithoutInteraction(content.querySelector<HTMLElement>('[data-testid="quick-filter"] > summary')));
    };
    select.addEventListener('keydown', event => {
      if (event.key === 'Enter') { if (select.value !== drawn) { event.preventDefault(); apply(); } return; }
      // Space opens the list, whose own keys never reach the select; a pick there is a pick.
      if (!event.altKey && (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' || event.key.startsWith('Page') || (event.key.length === 1 && event.key !== ' '))) keyed = true;
    });
    select.addEventListener('pointerdown', () => { keyed = false; });
    select.addEventListener('change', () => { if (keyed) { keyed = false; return; } apply(); });
    select.addEventListener('blur', apply);
  }
  content.querySelector<HTMLButtonElement>('[data-quick-filter-clear]')?.addEventListener('click', () => {
    if (state.actionInFlight || refuseWhileDirty('widening the screen')) return;
    quickFilters.delete(surface.semanticId);
    void reopen(plan, surface);
  });
}

/** Reads the screen again under its pick: its record window, and a matrix's cells on the next chase. */
async function reopen(plan: ApplicationPlan, surface: SurfaceNodePlan): Promise<void> {
  leaveRecordContext();
  surfaceErrors.delete(surface.semanticId);
  surfaceWindows.delete(surface.semanticId);
  matrixCells.delete(surface.semanticId);
  state.actionInFlight = true;
  setBusy(true);
  try {
    await loadSurfaceWindow(plan.entity.semanticId, surface);
  } catch (error) {
    surfaceErrors.set(surface.semanticId, messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
    rerender();
  }
}

/**
 * The target records each reference field offers, read every time the menu opens so a record
 * added or renamed since is offered as it is now. One record past the ceiling is asked for,
 * so the menu learns it cannot list them from the read it was making anyway.
 */
async function readTargets(plan: ApplicationPlan): Promise<void> {
  const references = quickFilterFields(plan.entity.fields)
    .filter((field): field is FieldPlan & { reference: { targetEntityId: string; labelFieldId: string } } => field.reference != null);
  if (references.length === 0) return;
  for (const field of references) quickFilterTargets.set(field.reference.targetEntityId, { state: 'loading' });
  rerender();
  for (const field of references) {
    const { targetEntityId, labelFieldId } = field.reference;
    try {
      const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords',
        windowRequest(targetEntityId, { sortFieldId: labelFieldId, descending: false, filters: [] }, null, maximumQuickFilterTargets));
      quickFilterTargets.set(targetEntityId, page.nextCursor !== null
        ? { state: 'overflowing', ceiling: maximumQuickFilterTargets }
        : {
          state: 'ready',
          items: page.items.map(record => ({ recordId: record.recordId, label: String(record.values[labelFieldId] ?? '').trim() || '(No label)' })),
        });
    } catch (error) {
      quickFilterTargets.set(targetEntityId, { state: 'failed', message: messageFor(error) });
    }
  }
  rerender();
}
