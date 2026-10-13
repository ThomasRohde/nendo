import { prepareApplication } from './actions';
import { state } from './app-state';
import { counted, escapeAttribute, escapeHtml, messageFor } from './format';
import { type ApplicationPlan, type CompileResult } from './host';
import { activePlan, applicationPlans, currentRecipe } from './plan-selection';
import { content, rerender, showError } from './shell';
import { renameBoardProposal } from './studio';
import { cardKindFor, isWarning, relationDescription, surfaceCard, surfaceHealth, treeSurfaceCard, type SurfaceCardContext } from './surface-cards';
export { cardKindFor, relationDescription, surfaceCard, treeSurfaceCard };
import { customViewsPanel, wireCustomViewsPanel } from './view-packages';
import { fileViews } from './file-view-model';
import { viewTitle } from './view-frame-markup';
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
    ${valid ? `<div class="page-toolbar"><label class="select-field">Record type<select id="surface-entity">${applicationPlans().map(app => `<option value="${escapeAttribute(app.entity.semanticId)}" ${app.entity.semanticId === plan.entity.semanticId ? 'selected' : ''}>${escapeHtml(app.entity.displayName)}</option>`).join('')}</select></label><span class="toolbar-spacer"></span><span class="record-total">${counted(surfaceCount(plan), 'screen')}</span></div><div class="surface-list">
      ${plan.surfaces.map((root) => treeSurfaceCard(plan, root, cardContext())).join('')}
    </div>`
      : fileViews().length > 0 ? '' : diagnosticsMarkup(state.compilation)}
    ${fileViewsMarkup()}
    ${customViewsPanel()}
  </div>`;
  wireCustomViewsPanel(content);
  content.querySelector<HTMLSelectElement>('#surface-entity')?.addEventListener('change', event => {
    state.selectedApplicationEntity = (event.currentTarget as HTMLSelectElement).value; rerender();
  });
  content.querySelector<HTMLButtonElement>('#prepare-application')?.addEventListener('click', () => {
    if (recipe !== null) void prepareApplication(recipe, 'surfaces');
  });
  // Each board renames itself from its own card, addressed by its node (UIT-16).
  for (const form of content.querySelectorAll<HTMLFormElement>('[data-board-rename]'))
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = form.querySelector<HTMLInputElement>('[data-board-title]')?.value.trim() ?? '';
      const root = plan?.surfaces.find((node) => node.semanticId === form.dataset.boardRename) ?? null;
      if (plan === null || title.length === 0 || title === root?.properties.title) return;
      try {
        // The compiled plan names the root; the node it compiled from names the surface
        // the operation must address.
        const surfaceId = state.session.uiNodes.find((node) => node.nodeId === root?.semanticId)?.surfaceId;
        if (root === null || surfaceId === undefined) throw new Error('This board is no longer in the open file. Read again before renaming it.');
        void prepareApplication({ actionLabel: 'Rename', applicationName: plan.entity.displayName, proposalPayload: renameBoardProposal(surfaceId, root.semanticId, title) }, 'surfaces');
      } catch (error) { showError(messageFor(error)); }
    });
}

/** The compiler's warnings and the custom-view switches, so a card says what stands in its way (UIT-03). */
function cardContext(): SurfaceCardContext {
  return { warnings: (state.compilation?.diagnostics ?? []).filter(isWarning), extensions: state.session.extensions ?? null };
}

/** The file's own views (W-106): screens of the file rather than of a record type, listed apart. */
function fileViewsMarkup(): string {
  const views = fileViews();
  if (views.length === 0) return '';
  return `<div class="page-toolbar"><span class="record-total">Screens of the file</span></div><div class="surface-list" data-testid="file-view-list">${views.map((view) =>
    surfaceCard('Custom view', viewTitle(view), view.semanticId, ['Custom view', typeof view.properties.packageId === 'string' ? `runs ${view.properties.packageId}` : null,
      view.properties.opensFile === true ? 'the file opens on it' : null].filter((part) => part !== null).join(' · '), surfaceHealth(view, cardContext()))).join('')}</div>`;
}

export function surfaceCount(plan: ApplicationPlan): number {
  return plan.surfaces.length;
}

export function diagnosticsMarkup(result: CompileResult | null): string {
  const diagnostics = result?.diagnostics ?? [];
  if (diagnostics.length === 0) {
    return '<section class="empty-inline"><h3>No screens yet</h3><p>Ask an agent to propose a form, list, board or action for your records. Review it here before using it.</p></section>';
  }
  return `<section class="diagnostics"><h3>Custom screens are unavailable</h3><p>Data remains available while you resolve the definition.</p>${diagnostics.map((item) => `<article><strong>${escapeHtml(item.message)}</strong><p>${escapeHtml(item.hint)}</p><code>${escapeHtml(item.code)}</code></article>`).join('')}</section>`;
}

