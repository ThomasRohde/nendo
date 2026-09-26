import { openWorkspaceView, prepareApplication } from './actions';
import { selectedSurfaces, state, type ViewName } from './app-state';
import { client } from './client';
import {
  addViewProposal, edgeChoices, pageChoices, refusalFor, showableFields, viewEntities, viewKinds, viewsOfPackage,
  type AddViewInput, type ViewKind, type ViewUse,
} from './custom-view-recipe';
import { storageKindName } from './extension-model';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import type { DesktopSessionView, ExtensionPackageView, ProposalPreview } from './host';
import { announce, clearError, content, focusWithoutInteraction, rerender, setBusy, showError, showOutcome } from './shell';
import { customViewsPanelMarkup } from './view-frame-markup';

/**
 * Studio → Surfaces → Custom views (ADR-0013): whether views run on this device, and the
 * packages that carry their code in this file.
 *
 * The two switches are device settings, like the theme: they never reach the file, and they
 * stay usable in a file opened read-only, because turning views off is how a person gets out
 * of a view that misbehaves. Adding and removing a package change the file's definition, so
 * both arrive as a proposal in the review Studio uses for every other definition change.
 */

/** Studio → Surfaces, scrolled to Custom views: where a placeholder and the File menu send a person to turn views on. */
export async function openCustomViews(): Promise<void> {
  await openWorkspaceView('surfaces');
  if (state.view === 'surfaces') document.getElementById('custom-views')?.scrollIntoView({ block: 'start' });
}

export function customViewsPanel(): string {
  return customViewsPanelMarkup(state.session.extensions, state.session.fileName, (pkg) => ({
    actions: `${developmentActions(pkg)}<button type="button" class="secondary-button" data-action data-view-add="${escapeAttribute(pkg.packageId)}" aria-expanded="${draft?.packageId === pkg.packageId}">Add view…</button>`,
    body: `${packageUsesMarkup(pkg)}${draft?.packageId === pkg.packageId ? addViewFormMarkup(pkg, draft) : ''}`,
  }));
}

/* --- Developing a package from a folder (ADR-0013 Phase 4, W-063) ------------ */

/** The card's development controls: start, or say where it runs from and how to save or stop. */
function developmentActions(pkg: ExtensionPackageView): string {
  if (client.mode !== 'desktop') return '';
  const id = escapeAttribute(pkg.packageId);
  if (typeof pkg.developmentFolder === 'string' && pkg.developmentFolder.length > 0)
    return `<span class="package-developing" title="This computer runs this package from that folder, not the code in the file.">Developing from ${escapeHtml(pkg.developmentFolder)}</span>` +
      `<button type="button" class="secondary-button" data-action data-develop-save="${id}">Save to file…</button>` +
      `<button type="button" class="secondary-button" data-action data-develop-stop="${id}">Stop developing</button>`;
  return `<button type="button" class="secondary-button" data-action data-develop-link="${id}">Develop from folder…</button>`;
}

/**
 * Develop from folder: the host picks the folder; the answer is the session, naming the folder
 * only. The host then says the package changed, which reloads its views (view-frames.ts).
 */
async function developPackage(packageId: string): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<DesktopSessionView | { cancelled: true }>('extension.develop.link', { packageId });
    if ('cancelled' in result) return;
    state.session = result;
    rerender();
    const folder = result.extensions?.packages.find((pkg) => pkg.packageId === packageId)?.developmentFolder ?? 'the folder';
    showOutcome(`This computer now runs ${packageId} from ${folder}. Save there and its views load it again.`);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function stopDeveloping(packageId: string): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    state.session = await client.request<DesktopSessionView>('extension.develop.stop', { packageId });
    rerender();
    showOutcome(`${packageId} runs the code in the file again.`);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/** Save to file: the folder as the proposal Import would prepare, in the ordinary review. */
export async function saveDevelopment(packageId: string): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    review(await client.request<ProposalPreview>('extension.develop.save', { packageId }), state.view);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/* --- Where a package is shown, and the Add view form (W-062) ------------------ */

/** The form as the person has it so far; one package's at a time. Not the file's, and gone with the page. */
let draft: AddViewInput | null = null;

/** The view a Studio proposal is adding, so accepting it can land the person on it. */
let adding: { proposalId: string; kind: ViewKind; nodeId: string; title: string; entityId: string; pageTitle: string | null } | null = null;

function entityName(entityId: string | null): string {
  return state.session.entities.find((entity) => entity.entityId === entityId)?.displayName ?? 'records';
}

function whereItIs(use: ViewUse): string {
  if (use.kind === 'panel') return `a panel on ${use.pageTitle ?? 'the record page'}, for each ${entityName(use.entityId)} record`;
  return `${use.kind === 'graph' ? 'a graph' : 'a screen'} under View in ${entityName(use.entityId)}`;
}

/** The screens and pages that show this package, each named where a person would find it. */
function packageUsesMarkup(pkg: ExtensionPackageView): string {
  const uses = viewsOfPackage(pkg.packageId, state.session.uiNodes);
  if (uses.length === 0)
    return `<p class="package-uses package-uses-none">Not shown anywhere yet. Add a view to put it on a screen or a record page.</p>`;
  return `<ul class="package-uses" aria-label="Where ${escapeAttribute(pkg.title)} is shown">${uses.map((use) =>
    `<li><strong>${escapeHtml(use.title)}</strong> <span>${escapeHtml(whereItIs(use))}</span>${use.kind === 'panel' || use.entityId === null ? ''
      : ` <button type="button" class="text-button" data-view-open="${escapeAttribute(use.nodeId)}" data-view-entity="${escapeAttribute(use.entityId)}">Open</button>`}</li>`).join('')}</ul>`;
}

/** Sensible first choices, so the form opens ready to preview whenever the file allows it. */
function initialDraft(pkg: ExtensionPackageView, kind: ViewKind = 'records'): AddViewInput {
  const entities = state.session.entities;
  const base: AddViewInput = { kind, packageId: pkg.packageId, title: draft?.packageId === pkg.packageId ? draft.title : pkg.title, entityId: '', labelFieldId: '', statusFieldId: null };
  if (kind === 'panel') {
    const page = pageChoices(state.session.uiNodes, entities)[0];
    return fillFields({ ...base, entityId: page?.entityId ?? '', pageNodeId: page?.nodeId ?? null });
  }
  const candidates = viewEntities(entities);
  const entity = kind === 'graph'
    ? candidates.find((candidate) => edgeChoices(entities, candidate.entityId).length > 0) ?? candidates[0]
    : candidates[0];
  return fillFields({ ...base, entityId: entity?.entityId ?? '' });
}

/** Label, status and the link's ends, chosen again for a record type the person just changed. */
function fillFields(input: AddViewInput): AddViewInput {
  const entity = state.session.entities.find((candidate) => candidate.entityId === input.entityId);
  const fields = entity === undefined ? [] : showableFields(entity);
  const text = entity?.fields.find((field) => fields.some((choice) => choice.fieldId === field.fieldId) &&
    storageKindName(field.storageKind) === 'text');
  const next: AddViewInput = { ...input, labelFieldId: text?.fieldId ?? fields[0]?.fieldId ?? '', statusFieldId: null };
  if (input.kind === 'graph') {
    const edge = edgeChoices(state.session.entities, input.entityId)[0];
    next.edgeEntityId = edge?.entity.entityId ?? null;
    next.sourceFieldId = edge?.references[0]?.fieldId ?? null;
    next.targetFieldId = edge?.references[1]?.fieldId ?? null;
  }
  return next;
}

function options(choices: ReadonlyArray<{ value: string; label: string }>, selected: string | null | undefined, none?: string): string {
  return `${none === undefined ? '' : `<option value="" ${selected == null || selected === '' ? 'selected' : ''}>${escapeHtml(none)}</option>`}${choices.map((choice) =>
    `<option value="${escapeAttribute(choice.value)}" ${choice.value === selected ? 'selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}`;
}

function addViewFormMarkup(pkg: ExtensionPackageView, input: AddViewInput): string {
  const entities = state.session.entities;
  const entity = entities.find((candidate) => candidate.entityId === input.entityId);
  const fields = entity === undefined ? [] : showableFields(entity).map((field) => ({ value: field.fieldId, label: field.displayName }));
  const refusal = refusalFor(input, { entities, nodes: state.session.uiNodes, id: 'preview' });
  const kinds = viewKinds.map((kind) => `<label class="add-view-kind"><input type="radio" id="add-view-kind-${kind.kind}" name="add-view-kind" value="${kind.kind}" ${kind.kind === input.kind ? 'checked' : ''} data-add-view="kind" /><span><strong>${escapeHtml(kind.label)}</strong><small>${escapeHtml(kind.detail)}</small></span></label>`).join('');
  const where = input.kind === 'panel'
    ? `<label class="add-view-field">Record page<select id="add-view-page" data-add-view="page">${options(pageChoices(state.session.uiNodes, entities).map((page) => ({ value: page.nodeId, label: `${page.title} · ${entityName(page.entityId)}` })), input.pageNodeId)}</select></label>`
    : `<label class="add-view-field">Record type<select id="add-view-entity" data-add-view="entity">${options(viewEntities(entities).map((candidate) => ({ value: candidate.entityId, label: candidate.displayName })), input.entityId)}</select></label>`;
  const edges = input.kind === 'graph' ? edgeChoices(entities, input.entityId) : [];
  const edge = edges.find((choice) => choice.entity.entityId === input.edgeEntityId);
  const ends = (edge?.references ?? []).map((field) => ({ value: field.fieldId, label: field.displayName }));
  const graph = input.kind !== 'graph' || edges.length === 0 ? '' : `<label class="add-view-field">Links<select id="add-view-edge" data-add-view="edge">${options(edges.map((choice) => ({ value: choice.entity.entityId, label: choice.entity.displayName })), input.edgeEntityId)}</select></label>
       <label class="add-view-field">From<select id="add-view-source" data-add-view="source">${options(ends, input.sourceFieldId)}</select></label>
       <label class="add-view-field">To<select id="add-view-target" data-add-view="target">${options(ends, input.targetFieldId)}</select></label>`;
  return `<form class="add-view-form" id="add-view-form" aria-label="Add a view of ${escapeAttribute(pkg.title)}" novalidate>
    <fieldset class="add-view-kinds"><legend>What to add</legend>${kinds}</fieldset>
    <div class="add-view-grid">
      <label class="add-view-field">Title<input id="add-view-title" type="text" maxlength="120" value="${escapeAttribute(input.title)}" data-add-view="title" /></label>
      ${where}
      <label class="add-view-field">Label<select id="add-view-label" data-add-view="label">${options(fields, input.labelFieldId)}</select></label>
      <label class="add-view-field">Status<select id="add-view-status" data-add-view="status">${options(fields, input.statusFieldId, 'None')}</select></label>
      ${graph}
    </div>
    <p class="add-view-note" id="add-view-refusal" role="status">${refusal === null ? `Only fields a view can show are offered. Preview makes a proposal; nothing changes until you accept it.` : escapeHtml(refusal)}</p>
    <div class="add-view-actions"><button type="submit" class="primary-button" data-action ${refusal === null ? '' : 'disabled'}>Preview view</button><button type="button" class="secondary-button" data-add-view-cancel>Cancel</button></div>
  </form>`;
}

/** Redraw the form after a choice that changes the others, keeping the person where they were. */
function redrawForm(focusId: string): void {
  rerender();
  focusWithoutInteraction(content.querySelector<HTMLElement>(`#${focusId}`));
}

function wireAddView(root: ParentNode): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-view-add]'))
    button.addEventListener('click', () => {
      const pkg = state.session.extensions?.packages.find((candidate) => candidate.packageId === button.dataset.viewAdd);
      if (pkg === undefined) return;
      if (draft?.packageId === pkg.packageId) { draft = null; rerender(); return; }
      draft = initialDraft(pkg);
      redrawForm('add-view-title');
    });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-view-open]'))
    button.addEventListener('click', () => void openView(button.dataset.viewEntity!, button.dataset.viewOpen!));
  const form = root.querySelector<HTMLFormElement>('#add-view-form');
  if (form === null || draft === null) return;
  const pkg = state.session.extensions?.packages.find((candidate) => candidate.packageId === draft!.packageId);
  if (pkg === undefined) { draft = null; return; }
  form.querySelector<HTMLInputElement>('#add-view-title')?.addEventListener('input', (event) => {
    if (draft === null) return;
    draft = { ...draft, title: (event.currentTarget as HTMLInputElement).value };
    const refusal = refusalFor(draft, { entities: state.session.entities, nodes: state.session.uiNodes, id: 'preview' });
    const note = form.querySelector<HTMLElement>('#add-view-refusal');
    if (note !== null) note.textContent = refusal ?? 'Only fields a view can show are offered. Preview makes a proposal; nothing changes until you accept it.';
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit !== null) submit.disabled = refusal !== null;
  });
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select[data-add-view], input[type="radio"][data-add-view]'))
    control.addEventListener('change', () => {
      if (draft === null) return;
      const value = control.value;
      switch (control.dataset.addView) {
        case 'kind': draft = initialDraft(pkg, value as ViewKind); redrawForm(`add-view-kind-${value}`); return;
        case 'entity': draft = fillFields({ ...draft, entityId: value }); break;
        case 'page': {
          const page = pageChoices(state.session.uiNodes, state.session.entities).find((candidate) => candidate.nodeId === value);
          draft = fillFields({ ...draft, pageNodeId: value, entityId: page?.entityId ?? '' });
          break;
        }
        case 'edge': {
          const edge = edgeChoices(state.session.entities, draft.entityId).find((choice) => choice.entity.entityId === value);
          draft = { ...draft, edgeEntityId: value, sourceFieldId: edge?.references[0]?.fieldId ?? null, targetFieldId: edge?.references[1]?.fieldId ?? null };
          break;
        }
        case 'label': draft = { ...draft, labelFieldId: value }; break;
        case 'status': draft = { ...draft, statusFieldId: value === '' ? null : value }; break;
        case 'source': draft = { ...draft, sourceFieldId: value }; break;
        case 'target': draft = { ...draft, targetFieldId: value }; break;
      }
      redrawForm(control.id);
    });
  form.querySelector<HTMLButtonElement>('[data-add-view-cancel]')?.addEventListener('click', () => {
    draft = null;
    rerender();
    focusWithoutInteraction(content.querySelector<HTMLElement>(`[data-view-add="${CSS.escape(pkg.packageId)}"]`));
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (draft === null) return;
    const id = crypto.randomUUID().replaceAll('-', '');
    let payload: Record<string, unknown>;
    try {
      payload = addViewProposal(draft, { entities: state.session.entities, nodes: state.session.uiNodes, id });
    } catch (error) {
      showError(messageFor(error));
      return;
    }
    const page = pageChoices(state.session.uiNodes, state.session.entities).find((candidate) => candidate.nodeId === draft!.pageNodeId);
    adding = { proposalId: payload.proposalId as string, kind: draft.kind, nodeId: `node.view.${id}`, title: draft.title.trim(),
      entityId: draft.entityId, pageTitle: draft.kind === 'panel' ? page?.title ?? null : null };
    draft = null;
    void prepareApplication({ actionLabel: 'Add view', applicationName: adding.title, proposalPayload: payload }, 'surfaces');
  });
}

/** Use, on the record type and screen a view is, as though the person had picked both. */
async function openView(entityId: string, nodeId: string): Promise<void> {
  state.selectedApplicationEntity = entityId;
  state.showOverview = false;
  selectedSurfaces.set(entityId, nodeId);
  await openWorkspaceView('use');
}

/**
 * After a proposal is accepted: when it was a view this form made, put the person where it
 * is and say so. A screen is selected in Use; a panel has no page without a record, so it is
 * named rather than opened. Returns the sentence, or null for any other proposal.
 */
export function landAddedView(proposalId: string): string | null {
  const added = adding;
  if (added === null || added.proposalId !== proposalId) return null;
  adding = null;
  if (added.kind === 'panel')
    return `${added.title} is a panel on ${added.pageTitle ?? 'the record page'}. Open any ${entityName(added.entityId)} record to see it.`;
  state.selectedApplicationEntity = added.entityId;
  state.showOverview = false;
  selectedSurfaces.set(added.entityId, added.nodeId);
  return `${added.title} is under View in ${entityName(added.entityId)}, and open now.`;
}

export function wireCustomViewsPanel(root: ParentNode): void {
  for (const toggle of root.querySelectorAll<HTMLButtonElement>('[data-view-switch]'))
    toggle.addEventListener('click', () => {
      const scope = toggle.dataset.viewSwitch === 'file' ? 'file' : 'device';
      void setViewSwitch(scope, toggle.getAttribute('aria-pressed') !== 'true');
    });
  root.querySelector<HTMLButtonElement>('[data-view-resume]')?.addEventListener('click', () => void setViewSwitch('device', true));
  root.querySelector<HTMLButtonElement>('[data-package-import]')?.addEventListener('click', () => void importPackage('surfaces'));
  wireAddView(root);
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-package-export]'))
    button.addEventListener('click', () => void exportPackage(button.dataset.packageExport!));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-package-remove]'))
    button.addEventListener('click', () => void removePackage(button.dataset.packageRemove!));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-develop-link]'))
    button.addEventListener('click', () => void developPackage(button.dataset.developLink!));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-develop-save]'))
    button.addEventListener('click', () => void saveDevelopment(button.dataset.developSave!));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-develop-stop]'))
    button.addEventListener('click', () => void stopDeveloping(button.dataset.developStop!));
}

/**
 * One of the two switches. The host answers with the snapshot, whose `extensions` now says
 * what runs; turning the device's switch on also ends a restart without custom views. The
 * snapshot may come bare or as `{ session }`, as the other file actions' answers do.
 */
export async function setViewSwitch(scope: 'device' | 'file', enabled: boolean): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<DesktopSessionView | { session: DesktopSessionView }>('extension.settings.set', { scope, enabled });
    state.session = 'session' in result ? result.session : result;
    rerender();
    announce(scope === 'device'
      ? enabled ? 'Custom views are on for this device.' : 'Custom views are off for this device.'
      : enabled ? 'This file’s custom views are on for this device.' : 'This file’s custom views are off for this device.');
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/** A proposal the host prepared, opened in Studio's review; Back returns to where it began. */
function review(preview: ProposalPreview, returnView: ViewName): void {
  state.proposal = preview;
  state.agentProposal = null;
  state.proposalReturnView = returnView;
  state.view = 'proposal';
  rerender();
  announce('Proposal ready to review.');
}

/**
 * Add a package from a folder, a .zip or a legacy .nendoview. The host opens its own picker
 * and answers with the proposal it prepared, or with nothing when the person cancelled.
 */
export async function importPackage(returnView: ViewName): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<ProposalPreview | { cancelled: true }>('extension.import');
    if ('cancelled' in result) return;
    review(result, returnView);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/** Write a package's files to a folder the person picks. Nothing in the file changes. */
export async function exportPackage(packageId: string): Promise<void> {
  if (state.actionInFlight) return;
  const title = state.session.extensions?.packages.find((pkg) => pkg.packageId === packageId)?.title ?? packageId;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<{ exported: boolean; fileCount: number; folderName?: string | null }>('extension.export', { packageId });
    const files = `${result.fileCount} ${result.fileCount === 1 ? 'file' : 'files'}`;
    if (result.exported)
      showOutcome(typeof result.folderName === 'string' && result.folderName.length > 0
        ? `Exported ${files} of ${title} to ${result.folderName}.`
        : `Exported ${files} of ${title}.`);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/** Remove a package and its files from the file, as a proposal to review. */
export async function removePackage(packageId: string): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    review(await client.request<ProposalPreview>('extension.remove', { packageId }), 'surfaces');
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}
