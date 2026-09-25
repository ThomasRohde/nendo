import { openWorkspaceView } from './actions';
import { state, type ViewName } from './app-state';
import { client } from './client';
import { messageFor } from './format';
import type { DesktopSessionView, ProposalPreview } from './host';
import { announce, clearError, rerender, setBusy, showError, showOutcome } from './shell';
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
  return customViewsPanelMarkup(state.session.extensions, state.session.fileName);
}

export function wireCustomViewsPanel(root: ParentNode): void {
  for (const toggle of root.querySelectorAll<HTMLButtonElement>('[data-view-switch]'))
    toggle.addEventListener('click', () => {
      const scope = toggle.dataset.viewSwitch === 'file' ? 'file' : 'device';
      void setViewSwitch(scope, toggle.getAttribute('aria-pressed') !== 'true');
    });
  root.querySelector<HTMLButtonElement>('[data-view-resume]')?.addEventListener('click', () => void setViewSwitch('device', true));
  root.querySelector<HTMLButtonElement>('[data-package-import]')?.addEventListener('click', () => void importPackage('surfaces'));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-package-export]'))
    button.addEventListener('click', () => void exportPackage(button.dataset.packageExport!));
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-package-remove]'))
    button.addEventListener('click', () => void removePackage(button.dataset.packageRemove!));
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
