import { runMutation } from './actions';
import { leaveRecordContext, selectedTabs, state, tabStateKey } from './app-state';
import { noteTabsChanged } from './navigation-trail';
import { chartKey } from './charts';
import { client } from './client';
import { refuseWhileDirty } from './draft-guard';
import { foldSection } from './fold-state';
import { escapeHtml, messageFor, mutationKey, sameValue, storageLabel, stringValue, valueDisplay } from './format';
import { type ApplicationPlan, type FieldPlan, type ReadPage, type RecordPlan, type RecordSnapshot } from './host';
import { refreshVisibleTiles, wireCharts, wireSummaryRetry } from './panels';
import { relatedLists, visibleCharts, visibleTiles } from './plan-selection';
import { loadRelatedWindow, loadRelatedWindows } from './reads';
import { wireRelatedActions } from './related-actions';
import { chartTileMarkup, relatedListMarkup, summaryTileMarkup } from './record-markup';
import { referenceVersions, wireReferenceControls } from './reference-controls';
import { parseScalar } from './scalars';
import { content, requiredElement, rerender, showError, showOutcome } from './shell';
import { tileKey } from './summary-tiles';
import { pageRoot } from './surface-model';
/**
 * The record form on screen: what the owner has typed, which tab is open, and
 * what is sent when they save.
 *
 * Every panel is inside the one form, so changing tab never discards typing and
 * a save carries exactly what a fully expanded page would have carried. Where
 * the page owns tabs it owns validation too, because a required field in a
 * hidden panel is not focusable and the browser would block the submit with an
 * error nobody can act on.
 */

/** Whether a page renders tabs, which is what makes owned validation necessary. */
export function wireRecordForm(
  record: RecordPlan | null,
  entityId: string,
  fields: FieldPlan[],
  close: () => void,
  page: ApplicationPlan | null = null,
): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('#close-inspector, #cancel-create')) button.addEventListener('click', close);
  if (page !== null) { wireTabs(page, record); wireFolds(page, record); }
  const editedFields = new Set<string>();
  const recordForm = requiredElement<HTMLFormElement>('#record-form');
  if (state.session.entities.find(entity => entity.entityId === entityId)?.retired)
    for (const control of recordForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button')) control.disabled = true;
  recordForm.querySelector<HTMLButtonElement>('#delete-record')?.addEventListener('click', () => {
    if (record === null) return;
    const titleField = fields.find(field => storageLabel(field.storageKind) === 'Text');
    const title = titleField ? valueDisplay(record.values[titleField.semanticId]) : record.semanticId;
    const dialog = document.createElement('dialog');
    dialog.className = 'record-delete-dialog';
    dialog.setAttribute('aria-labelledby', 'delete-record-heading');
    dialog.innerHTML = `<h2 id="delete-record-heading">Delete this record?</h2><p>${escapeHtml(title || record.semanticId)}</p>
      <p>Its values will be retained in History for restoration while its schema and references remain valid. Incoming references must be cleared or reassigned first.</p>
      <div class="form-actions"><button class="secondary-button" data-cancel type="button" autofocus>Cancel</button><button class="primary-button" data-confirm type="button">Delete record</button></div>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.querySelector('[data-cancel]')?.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-confirm]')?.addEventListener('click', () => {
      dialog.close();
      void runMutation('data.deleteRecord', { entityId, recordId: record.semanticId, expectedRecordVersion: record.version,
        idempotencyKey: mutationKey() }, 'Record deleted. Open History to review or restore it.', true,
      // The whole record context, not the selection alone: a record deleted after being
      // opened from a related row left its "Back to" standing on the surface behind it,
      // offering a way back to the page nobody was on.
      () => leaveRecordContext());
    });
    dialog.showModal();
  });
  wireReferenceControls(recordForm, state.session.entities.flatMap(entity => entity.fields),
    payload => client.request<ReadPage<RecordSnapshot>>('data.queryRecords', payload));
  const fieldsById = new Map(fields.map((field) => [field.semanticId, field]));
  /**
   * Which fields the form holds a value for that differs from what is stored.
   *
   * Only a declared field's own control, or its Not set toggle, counts. A reference
   * picker's search box sits inside the form too, and has no name: typing in it changes
   * nothing a save would carry, and it used to add an empty name to this set, after which
   * the page refused to be left until a save that had nothing to save (W-050). And a field
   * typed into and put back is compared, not remembered: edited means different from
   * stored, on the same terms the save decides what to send, so the page is dirty exactly
   * when saving it would write. A create form has nothing stored to compare with, so
   * there every touched field counts.
   */
  const trackEdit = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
    const fieldId = target.dataset.nullField ?? target.name;
    const field = fieldsById.get(fieldId);
    if (field === undefined) return;
    if (!target.dataset.nullField) {
      const unset = recordForm.querySelector<HTMLInputElement>(`[data-null-field="${CSS.escape(fieldId)}"]`);
      if (unset) unset.checked = false;
    }
    if (record !== null && sameAsStored(record, field, recordForm)) editedFields.delete(fieldId);
    else editedFields.add(fieldId);
  };
  recordForm.addEventListener('input', trackEdit);
  recordForm.addEventListener('change', trackEdit);
  state.openDraft = { session: { fileSessionId: state.session.fileSessionId, canMutate: state.session.capabilities.mutate }, edited: editedFields };
  requiredElement<HTMLFormElement>('#record-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    let values: Record<string, unknown>;
    try {
      values = Object.fromEntries(fields.map((field) => [field.semanticId,
        record !== null && !editedFields.has(field.semanticId) ? record.values[field.semanticId] : formValue(field, form)]));
    } catch (error) { showError(messageFor(error)); return; }
    // Every declared field is checked, including one in a closed tab. The
    // browser would refuse to focus a hidden required control and block the
    // submit with an error nobody can act on, so the page does this itself.
    const missing = fields.find((field) => !field.retired && field.required && (values[field.semanticId] === null || values[field.semanticId] === ''));
    if (missing !== undefined) {
      if (page !== null) revealField(page, missing.semanticId);
      showError(`${missing.displayName} is required.`);
      return;
    }
    if (record === null) {
      void runMutation('data.createRecord', { entityId, recordId: crypto.randomUUID(), values, expectedTargetVersions: referenceVersions(recordForm, values), idempotencyKey: mutationKey() }, 'Record added.', true, () => {
        state.creatingRecord = false;
        // A record added from a related list returns to the page it was added from, which
        // is still the selected record. Its relation is now a revision behind and is read
        // again by the chase that draws it.
        state.createRelated = null;
      });
    } else {
      // A save that finds nothing to send does not redraw, so the form on screen is
      // still the form — and it holds nothing the file does not, so it is not dirty.
      void saveRecordChanges(entityId, record, fields, values, referenceVersions(recordForm, values))
        .then((saved) => { if (!saved) editedFields.clear(); });
    }
  });
}

export function formValue(field: FieldPlan, form: FormData): unknown {
  if (form.get(`__unset:${field.semanticId}`) === 'true') return null;
  if (field.presentation === 'singleChoice' && !form.get(field.semanticId)) return null;
  return parseScalar(storageLabel(field.storageKind), stringValue(form.get(field.semanticId)));
}

/**
 * Whether the form's value for one field is what the record stores, read the way a save
 * reads it. A value the save could not parse is not the stored one either.
 */
function sameAsStored(record: RecordPlan, field: FieldPlan, form: HTMLFormElement): boolean {
  try {
    return sameValue(record.values[field.semanticId], formValue(field, new FormData(form)));
  } catch {
    return false;
  }
}

/** Send what differs from the record. True when a save was sent; false when nothing differed. */
export async function saveRecordChanges(
  entityId: string,
  record: RecordPlan,
  fields: FieldPlan[],
  values: Record<string, unknown>,
  targetVersions: Record<string, number> = {},
): Promise<boolean> {
  const changes = fields.map((field) => [field.semanticId, values[field.semanticId]] as const)
    .filter(([fieldId, value]) => !sameValue(record.values[fieldId], value));
  if (changes.length === 0) {
    // Said where a person can see it, not only to a screen reader: the button they
    // pressed did nothing, and the form is unchanged, and both are true.
    showOutcome('No changes to save.');
    return false;
  }
  await runMutation('data.setFields', {
    entityId,
    recordId: record.semanticId,
    expectedRecordVersion: record.version,
    values: Object.fromEntries(changes),
    expectedTargetVersions: Object.fromEntries(changes.filter(([id]) => id in targetVersions).map(([id]) => [id, targetVersions[id]])),
    idempotencyKey: mutationKey(),
  }, 'Record saved.', true);
  return true;
}

export function closeInspector(): void {
  // The whole record context, for the reason the delete callback gives: closing a record
  // opened from a related row used to leave its "Back to" standing on the surface behind.
  leaveRecordContext();
  rerender();
}

/**
 * Tabs, wired in place. Switching tab must not re-render the form: the draft
 * values and validation state of every panel live in the DOM, and a re-render
 * would discard whatever was typed in the tab being left.
 */
/**
 * Folds, wired in place for the same reason tabs are: a redraw would discard the
 * drafts on the rest of the page. Opening a section may uncover a relation or a total
 * nothing has read yet, because a closed section reads nothing; those are read and
 * patched in place, exactly as a tab change does it.
 */
export function wireFolds(plan: ApplicationPlan, record: RecordPlan | null): void {
  for (const fold of content.querySelectorAll<HTMLDetailsElement>('#record-form details[data-section]')) {
    // Chromium fires toggle on a details inserted open; only a change from what was
    // drawn is a fold, or every redraw would read the section's panels again.
    let drawn = fold.open;
    fold.addEventListener('toggle', () => {
      if (fold.open === drawn) return;
      drawn = fold.open;
      const byPerson = fold.dataset.revealed !== 'true';
      delete fold.dataset.revealed;
      foldSection(fold.dataset.section!, fold.open, byPerson);
      if (!fold.open || record === null) return;
      void (async () => {
        await loadRelatedWindows(plan, record.semanticId);
        await refreshVisibleTiles(plan);
        patchReadOnlyPanels(plan, record);
      })().catch((error) => showError(messageFor(error)));
    });
  }
}

export function wireTabs(plan: ApplicationPlan, record: RecordPlan | null): void {
  const groups = new Map<string, HTMLButtonElement[]>();
  for (const tab of content.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]')) {
    const groupId = tab.dataset.tabGroup!;
    groups.set(groupId, [...(groups.get(groupId) ?? []), tab]);
  }
  for (const [groupId, tabs] of groups) {
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => { activateTab(plan, record, groupId, tab.dataset.tab!); });
      // Roving focus: one tab stop for the strip, arrows move within it.
      tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
          : 0;
        const target = step !== 0 ? tabs[(index + step + tabs.length) % tabs.length]
          : event.key === 'Home' ? tabs[0]
          : event.key === 'End' ? tabs[tabs.length - 1]
          : null;
        if (target === null) return;
        event.preventDefault();
        activateTab(plan, record, groupId, target.dataset.tab!);
        target.focus();
      });
    }
  }
}

export function activateTab(
  plan: ApplicationPlan,
  record: RecordPlan | null,
  groupId: string,
  sectionId: string,
): void {
  const root = pageRoot(plan);
  if (root === null) return;
  selectedTabs.set(tabStateKey(plan.entity.semanticId, root.semanticId, groupId), sectionId);
  // This is a move that draws nothing: the tablist is patched in place on purpose, so
  // that the drafts in every panel survive. The trail is told directly, or the place the
  // person is on would keep the tab from the last draw — restoring the wrong one later,
  // and reading as a move the first time anything else redrew.
  noteTabsChanged(plan.entity.semanticId);
  for (const tab of content.querySelectorAll<HTMLButtonElement>(`[role="tab"][data-tab-group="${CSS.escape(groupId)}"]`)) {
    const selected = tab.dataset.tab === sectionId;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of content.querySelectorAll<HTMLElement>(`[data-tab-panel][data-tab-group="${CSS.escape(groupId)}"]`))
    panel.hidden = panel.dataset.tabPanel !== sectionId;
  if (record === null) return;
  // The panel just opened may hold a relation or a total nothing has read yet.
  // Both are read-only, so their markup is patched in place rather than through
  // a re-render that would drop the form drafts this tab change preserved.
  void (async () => {
    await loadRelatedWindows(plan, record.semanticId);
    await refreshVisibleTiles(plan);
    patchReadOnlyPanels(plan, record);
  })().catch(error => showError(messageFor(error)));
}

/**
 * Re-render the read-only parts of the record page — related lists and totals —
 * without touching the form controls around them.
 */
export function patchReadOnlyPanels(plan: ApplicationPlan, record: RecordPlan): void {
  for (const element of content.querySelectorAll<HTMLElement>('[data-related]')) {
    const node = relatedLists(plan).find((candidate) => candidate.semanticId === element.dataset.related);
    if (node !== undefined) element.outerHTML = relatedListMarkup(node, record);
  }
  const tiles = new Map(visibleTiles(plan).map((scoped) => [tileKey(scoped.tile, scoped.scope), scoped]));
  for (const element of content.querySelectorAll<HTMLElement>('[data-summary-key]')) {
    const scoped = tiles.get(element.dataset.summaryKey ?? '');
    if (scoped !== undefined) element.outerHTML = summaryTileMarkup(scoped.tile, scoped.scope);
  }
  const charts = new Map(visibleCharts(plan).map((scoped) => [chartKey(scoped.node, scoped.scope), scoped]));
  for (const element of content.querySelectorAll<HTMLElement>('[data-chart-key]')) {
    const scoped = charts.get(element.dataset.chartKey ?? '');
    if (scoped !== undefined) element.outerHTML = chartTileMarkup(plan, scoped);
  }
  wireSummaryRetry(plan);
  wireCharts(plan);
  // The relations were replaced by their new markup above, so the Add, open and page
  // buttons on screen are not the ones that were wired when the page was drawn.
  wireRelatedActions(plan, record);
  wireRelatedPager(plan, record);
}

/**
 * A relation's pager, wired wherever its markup has just been written.
 *
 * The next page is read and then patched in, through the same path a tab change takes,
 * because the form around the relation may hold unsaved typing and a redraw would lose
 * it. That is what this used to do: page the relation, redraw the page, and rebuild the
 * parent's form from stored values (W-049).
 */
export function wireRelatedPager(plan: ApplicationPlan, record: RecordPlan): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-related-page]'))
    button.addEventListener('click', () => void (async () => {
      if (await loadRelatedWindow(button.dataset.relatedKey!, Number(button.dataset.relatedPage)))
        patchReadOnlyPanels(plan, record);
    })());
}

/**
 * Open the tab a field lives in, and return whether it was found. A required
 * field in a closed tab cannot be focused, so the failure has to move the view
 * to it before it is reported.
 */
export function revealField(plan: ApplicationPlan, fieldId: string): void {
  const control = content.querySelector<HTMLElement>(`#record-form [name="${CSS.escape(fieldId)}"]`);
  if (control === null) return;
  for (let panel = control.closest<HTMLElement>('[data-tab-panel]'); panel !== null;
    panel = panel.parentElement?.closest<HTMLElement>('[data-tab-panel]') ?? null)
    activateTab(plan, null, panel.dataset.tabGroup!, panel.dataset.tabPanel!);
  // A required field inside a folded section is revealed the way one inside a closed
  // tab is: the section opens, and the person sees what is being asked for.
  for (let fold = control.closest<HTMLDetailsElement>('details[data-section]'); fold !== null;
    fold = fold.parentElement?.closest<HTMLDetailsElement>('details[data-section]') ?? null) {
    // Not remembered for the device: the page opened it, the person did not. The toggle
    // this fires reads the mark and says the same.
    if (!fold.open) { fold.dataset.revealed = 'true'; fold.open = true; foldSection(fold.dataset.section!, true, false); }
  }
  control.focus();
  control.scrollIntoView({ block: 'nearest' });
}

/** The commands of a record page and its entity, with duplicate labels marked. */
export async function executeTreeCommand(plan: ApplicationPlan, record: RecordPlan, commandId: string, label: string): Promise<void> {
  // A command writes to the record on screen and redraws it, so unsaved typing would be
  // both overtaken and lost. It is declined rather than merged.
  if (refuseWhileDirty('running a command')) return;
  await runMutation('data.executeCommand', {
    commandId,
    entityId: plan.entity.semanticId,
    recordId: record.semanticId,
    expectedRecordVersion: record.version,
    idempotencyKey: mutationKey(),
  }, `${label} completed.`, true);
}

