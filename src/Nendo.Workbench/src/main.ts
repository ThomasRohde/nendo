// First, so that a Workbench loaded inside a frame stops before anything else has run.
import './frame-guard';
import { refreshAgentStatus, renderAgent, renderAgentProposal } from './view-agent';
import { destroyGrid, renderData } from './view-data';
import { refreshHealth, renderHealth } from './view-health';
import { renderHelp } from './view-help';
import { renderHistory } from './view-history';
import { renderProposal } from './view-proposal';
import { renderStructure } from './view-structure';
import { renderSurfaces } from './view-surfaces';
import { renderUse } from './view-use';
import { openHelp, openWorkspaceView, refreshDerived, resetFileView, retryPendingSave } from './actions';
import { createReadChase } from './read-chase';
import { followTarget, stillBehind, type FollowTarget } from './file-follow';
import { openDroppedFile, refreshRecentFiles, renderFileMenu, renderNoFile, renderUnavailable } from './file-actions';
import { describeDrag, judgeDrop } from './file-drop';
import { activePlan, overviewPlan, selectedSurfaceNode, sessionEntity } from './plan-selection';
import { showsOverview } from './view-overview';
import { overviewTitle } from './overview-model';
import { client } from './client';
import { announce, applyRail, applyTheme, content, historyBack, historyForward, isThemePreference, navigation, readPreference, readRailCollapsed, railToggle, requiredElement, root, sessionContext, sessionFile, sessionHealth, sessionStatus, sessionVersion, setAgentWork, setBusy, setRenderer, showError, stopInFlightWork, systemDark, themeButtons, workspaceTitle, rerender, markPlace } from './shell';
import { holdingThePage, refuseWhileDirty } from './draft-guard';
import { backTarget, forwardTarget, goBack, goForward, placeName, recordPlace } from './navigation-actions';
import { state } from './app-state';
import { installViewFrames, parkViewFrames, releaseViewFrames } from './view-frames';
import { capitalise, messageFor } from './format';
import {
  ClientSideRowModelModule,
  DateEditorModule,
  ModuleRegistry,
  RenderApiModule,
  SelectEditorModule,
  TextEditorModule,
} from 'ag-grid-community';
import type { DesktopSessionView } from './host';
import { surfaceLabel, useSurfaces } from './surface-model';
import { useFieldKinds } from './record-window';
import { storageKindName } from './extension-model';
import { icon, type IconName } from './icons';
import { openPalette } from './command-palette';
import { matchShortcut, shortcut, shortcutsShownFrom, shortcutsStorageKey, type ShortcutId } from './shortcuts';
import './styles.css';

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  DateEditorModule,
  RenderApiModule,
  SelectEditorModule,
  TextEditorModule,
]);

// A filter's `today` is a date for a Date field and an instant for a DateTime one, so the
// resolver asks the open session what kind each field is (R-003). One map per snapshot.
const fieldKindMaps = new WeakMap<DesktopSessionView, Map<string, string>>();
useFieldKinds((fieldId) => {
  let kinds = fieldKindMaps.get(state.session);
  if (kinds === undefined) {
    kinds = new Map(state.session.entities.flatMap((entity) => entity.fields.map((field) => [field.fieldId, storageKindName(field.storageKind)] as const)));
    fieldKindMaps.set(state.session, kinds);
  }
  return kinds.get(fieldId);
});

/**
 * The entry point: what index.html loads, and the only module that knows about
 * every view.
 *
 * It owns the router and the frame — which view is drawn into #studio-content,
 * what the chrome around it says, and the sweep that switches the page to
 * read-only — and it hands those two operations to the shell so that a view or
 * an action can ask for a redraw without importing back into here.
 */

function render(): void {
  // A custom view is a frame, and replacing the markup around it would reload it. Every
  // live frame is taken out of the page before the page goes, adopted by its new
  // placeholder while the view draws, and released at the end if nothing adopted it.
  parkViewFrames();
  // Named before the markup is replaced, so a redraw of the same screen can put the
  // reader back where they were. The surface is part of it: moving from one board to
  // another is a new screen and starts at the top.
  markPlace([
    state.view,
    state.session.fileSessionId ?? '',
    state.selectedApplicationEntity ?? '',
    state.proposal?.proposalId ?? '',
    state.agentProposal?.proposalId ?? '',
    showsOverview() ? 'overview' : '',
    (() => { const plan = activePlan(); return plan === null ? '' : selectedSurfaceNode(plan)?.semanticId ?? ''; })(),
  ].join('|'));
  destroyGrid();
  // The draft lives in the DOM this is about to replace.
  state.openDraft = null;
  // The one place a view is drawn is the one place the trail has to be told about a move,
  // rather than the dozens of call sites that change where somebody is.
  //
  // Before updateChrome, which draws the two arrows from the trail. Recording after it
  // left them a move behind every time a move took one draw rather than two — clicking
  // Studio from a fresh file left Back disabled although Alt+Left worked, and further
  // along a trail the label named the place before the one the button led to. The name
  // does not need updateChrome to have run: currentHeading only reads state.
  recordPlace(currentHeading());
  updateChrome();
  content.setAttribute('aria-busy', String(state.actionInFlight));
  // Help owns its own two scroll regions; every other view scrolls the content pane.
  content.classList.toggle('is-help', state.view === 'help');
  if (state.view === 'help') {
    renderHelp();
  } else if (client.mode === 'unavailable') {
    renderUnavailable();
  } else if (state.view === 'health' || (state.session.health === 'recoveryRequired' && state.session.manifest === null)) {
    renderHealth();
  } else if (!state.session.hasFile || state.session.manifest === null) {
    renderNoFile();
  } else if (state.view === 'proposal' && state.proposal !== null) {
    renderProposal();
  } else if (state.view === 'agentProposal' && state.agentProposal !== null) {
    renderAgentProposal();
  } else {
    switch (state.view) {
      case 'use': renderUse(); break;
      case 'structure': renderStructure(); break;
      case 'surfaces': renderSurfaces(); break;
      case 'history': renderHistory(); break;
      case 'agent': renderAgent(); break;
      default: renderData(); break;
    }
  }
  const awaitingSave = renderPendingMutation();
  if (state.view !== 'help' && (!state.session.capabilities.mutate || awaitingSave)) {
    for (const control of content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(alwaysAvailable)) {
      if (!awaitingSave && control.closest('#studio-query') && state.session.capabilities.readData) continue;
      control.disabled = true;
    }
  }
  setBusy(state.actionInFlight);
  releaseViewFrames();
}

/**
 * What the read-only sweep switches off, and what it deliberately does not.
 *
 * Opening a file, creating one, and approving or withdrawing this device's consent
 * are not edits to the open file — they are how a person gets out of the state that
 * switched editing off in the first place. Disabling the approval button exactly
 * when editing is unavailable leaves the only route forward greyed out.
 */
const alwaysAvailable =
  '[data-action]:not([data-file-action]):not(#create-file):not(#open-file):not(#approve-behaviour):not(#revoke-behaviour), input, select, textarea';

function renderPendingMutation(): boolean {
  let pending;
  let failure: string | null = null;
  try { pending = client.pendingMutation?.(); }
  catch (error) { failure = messageFor(error); }
  if (!pending && failure === null) return false;
  const accepting = pending?.method === 'proposal.promote';
  if (state.session.health === 'normal' && (failure !== null || pending?.state === 'pending')) {
    sessionHealth.dataset.state = 'warning';
    sessionHealth.lastChild?.remove();
    sessionHealth.append(document.createTextNode(accepting ? 'Acceptance unconfirmed' : 'Save unconfirmed'));
  }
  const notice = document.createElement('aside');
  notice.className = 'context-note';
  notice.id = 'pending-save-notice';
  notice.setAttribute('role', 'status');
  const message = document.createElement('p');
  message.textContent = failure ?? (pending?.state === 'notApplied'
    ? 'The proposal was not applied. Its local retry record still needs cleanup.' : pending?.state === 'committed'
    ? 'Your change is saved. Its local retry record still needs cleanup.'
    : accepting ? 'A proposal acceptance has not been confirmed. Check or retry that acceptance before making another change.'
    : 'A previous save has not been confirmed. Check or retry that saved request before making another change.');
  notice.append(message);
  if (failure === null) {
    const retry = document.createElement('button');
    retry.id = 'retry-pending-save';
    retry.type = 'button';
    retry.className = 'secondary-button';
    retry.textContent = pending?.state !== 'pending' ? 'Clear finished request' : accepting ? 'Check or retry acceptance' : 'Check or retry save';
    retry.disabled = !state.session.capabilities.mutate;
    retry.addEventListener('click', () => void retryPendingSave());
    notice.append(retry);
  }
  content.prepend(notice);
  return failure !== null || pending?.state === 'pending';
}

/**
 * What this place is called: the eyebrow above the title and the title itself.
 *
 * Read twice — once to write it into the header, and once so the trail can carry it, so
 * that the back button says where it goes without a second opinion about what a screen
 * is named.
 */
function currentHeading(): { eyebrow: string; title: string } {
  const current = activePlan();
  const overview = overviewPlan();
  const validUse = state.session.capabilities.customSurfaces && (current !== null || overview !== null);
  const entity = sessionEntity();
  return ((): { eyebrow: string; title: string } => {
    switch (state.view) {
      case 'help': return { eyebrow: 'How it works, guides & this app', title: 'Help' };
      case 'agent': return { eyebrow: 'Local collaboration', title: 'Agent access' };
      case 'agentProposal': return { eyebrow: 'Local collaboration', title: 'Review changes' };
      case 'proposal': return { eyebrow: 'Studio', title: 'Review changes' };
      case 'surfaces': return { eyebrow: 'Studio', title: 'Surfaces' };
      case 'history': return { eyebrow: 'Studio', title: 'History' };
      case 'health': return { eyebrow: 'Studio', title: 'File health' };
      case 'data': return { eyebrow: 'Studio', title: entity === null ? 'Data' : `${entity.displayName} data` };
      case 'structure': return { eyebrow: 'Studio', title: entity === null ? 'Structure' : `${entity.displayName} structure` };
      case 'use': return showsOverview() && overview !== null
        ? { eyebrow: 'Use', title: overviewTitle(overview) }
        : validUse && current !== null
          ? { eyebrow: `Use · ${current.entity.displayName}`,
              title: selectedSurfaceNode(current) === null ? current.entity.displayName
                : surfaceLabel(selectedSurfaceNode(current)!, useSurfaces(current)) }
          : { eyebrow: 'Studio', title: 'Use application' };
      default: return { eyebrow: 'Studio', title: 'Studio' };
    }
  })();
}

/**
 * What the two arrows say, and whether either leads anywhere.
 *
 * The name is the place itself, so a screen reader hears the destination rather than a
 * direction: "Back to Use · Work — All work". A button that leads nowhere is disabled and
 * says only what it is, because naming a place nobody can reach is worse than saying
 * nothing.
 */
function updateHistoryControls(): void {
  for (const [button, target, direction] of [
    [historyBack, backTarget(), 'Back'],
    [historyForward, forwardTarget(), 'Forward'],
  ] as const) {
    button.disabled = target === null;
    const name = target === null ? direction : `${direction} to ${placeName(target)}`;
    button.setAttribute('aria-label', name);
    button.title = name;
  }
}

function updateChrome(): void {
  const current = activePlan();
  // A file whose only compiled root is a front page has no application plan at
  // all, and Use is still where it is shown.
  const overview = overviewPlan();
  const validUse = state.session.capabilities.customSurfaces && (current !== null || overview !== null);
  // The header names the page, never the file. A page title that lives in the
  // scrolling content disappears the moment the owner scrolls; the file name is
  // fixed for the whole session and belongs in the status bar instead.
  const heading = currentHeading();
  const named = state.session.fileName !== null;
  workspaceTitle.textContent = named ? heading.title : 'No file open';
  sessionContext.textContent = named ? heading.eyebrow : '';
  sessionContext.hidden = !named;

  sessionFile.textContent = state.session.fileName ?? '';
  // The status bar stays up without a file so the build is always answerable;
  // only the file half of it depends on one being open.
  sessionFile.parentElement!.hidden = !named;
  sessionVersion.textContent = state.session.hostVersion ? `Nendo ${state.session.hostVersion}` : '';
  sessionStatus.hidden = state.session.hostVersion === undefined && !named;
  document.title = named ? `${state.session.fileName} — Nendo Studio` : 'Nendo Studio';

  // Healthy is the ordinary state and saving is automatic, so a permanent
  // "Saved locally" badge reports nothing. Show this pill only when the session
  // is constrained, where it carries the warning the owner actually needs.
  // A healthy file whose automatic actions await approval is not editable either,
  // and nothing else on the frame said why.
  const approvalNeeded = state.session.health === 'normal' && !state.session.capabilities.mutate &&
    state.session.behaviourTrust?.requiresApproval === true && !state.session.behaviourTrust.isApproved;
  sessionHealth.hidden = state.session.fileName === null || (state.session.health === 'normal' && !approvalNeeded);
  sessionHealth.dataset.state = 'warning';
  sessionHealth.lastChild?.remove();
  sessionHealth.append(document.createTextNode(approvalNeeded ? 'Approval needed' : state.session.health === 'readOnly' ? 'Read-only' : 'Recovery required'));

  navigation.use.disabled = !validUse;
  navigation.agent.disabled = !state.session.capabilities.agentAccess;
  navigation.data.disabled = navigation.structure.disabled = !state.session.capabilities.readData;
  navigation.surfaces.disabled = !state.session.capabilities.customSurfaces;
  navigation.history.disabled = !state.session.capabilities.readHistory;
  navigation.health.disabled = client.mode === 'unavailable';
  updateHistoryControls();
  renderFileMenu();
  const selected = state.view === 'proposal' ? state.proposalReturnView : state.view === 'agentProposal' ? 'agent' : state.view;
  for (const [name, button] of Object.entries(navigation)) {
    button.title = name === 'use' ? 'Use application' : name === 'agent' ? 'Agent access' : capitalise(name);
    const active = name === selected;
    button.classList.toggle('is-selected', active);
    button.classList.toggle('is-current', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const studioSelected = ['data', 'structure', 'surfaces', 'history', 'health', 'proposal'].includes(selected);
  navigation.studio.classList.toggle('is-selected', studioSelected);
  if (studioSelected) navigation.studio.setAttribute('aria-current', 'true');
  else navigation.studio.removeAttribute('aria-current');
}

/** Keep the typed values visible and stop anything on this page from saving them. */
async function initialise(): Promise<void> {
  applyTheme(readPreference());
  if (client.mode === 'unavailable') {
    render();
    return;
  }
  try {
    if (client.mode === 'desktop') {
      // Read before loading the application. A restarted renderer's localStorage
      // must not overwrite the device preference that already themed recovery.
      const appearance = await client.request<{ preference: string; notice: string | null }>('appearance.get');
      applyTheme(isThemePreference(appearance.preference) ? appearance.preference : 'system');
      if (appearance.notice) announce(appearance.notice);
    }
    state.session = await client.request<DesktopSessionView>('session.getSnapshot');
    // A restarted renderer may inspect an old receipt, but never automatically
    // resends an unacknowledged mutation. Explicit retry uses its retained key.
    try { await client.checkPendingMutation?.(); } catch { /* Render the retained pending state below. */ }
    resetFileView();
    await refreshRecentFiles();
    await refreshDerived();
    if (state.compilation?.isValid) state.view = 'use';
    render();
  } catch (error) {
    render();
    showError(messageFor(error));
  }
}

for (const [name, button] of Object.entries(navigation)) {
  button.querySelector('.nav-symbol')!.innerHTML = icon(name as IconName);
}
historyBack.innerHTML = icon('chevronLeft');
historyForward.innerHTML = icon('chevronRight');
historyBack.addEventListener('click', () => { void goBack(); });
historyForward.addEventListener('click', () => { void goForward(); });
// Here rather than in initialise(), which is async: the stored width has to be on the
// element before the first paint, or a folded rail opens at its full 196px and snaps shut.
applyRail(readRailCollapsed());
railToggle.addEventListener('click', () => { applyRail(root.dataset.rail !== 'collapsed', true); });
requiredElement<HTMLElement>('#file-icon').innerHTML = icon('file');
requiredElement<HTMLElement>('#status-file-icon').innerHTML = icon('file');
requiredElement<HTMLElement>('.file-chevron').innerHTML = icon('chevron');
for (const button of themeButtons) {
  button.innerHTML = icon(button.dataset.themeOption as 'system' | 'light' | 'dark');
}
requiredElement<HTMLElement>('#palette-icon').innerHTML = icon('search');
requiredElement<HTMLElement>('#command-palette-icon').innerHTML = icon('search');
const paletteOpen = requiredElement<HTMLButtonElement>('#palette-open');
paletteOpen.addEventListener('click', openPalette);

/**
 * Whether every shortcut is drawn beside its control.
 *
 * The person's own view of the window, like the theme and the rail: kept for the device,
 * never in the file, and off unless they turned it on. Storage that refuses to answer
 * leaves the hints off. The keys work either way; this only decides whether they show.
 */
const shortcutsToggle = requiredElement<HTMLButtonElement>('#shortcuts-toggle');
shortcutsToggle.innerHTML = icon('keyboard');

function readShortcutsShown(): boolean {
  try { return shortcutsShownFrom(window.localStorage.getItem(shortcutsStorageKey)); } catch { return false; }
}

function applyShortcuts(shown: boolean, persist = false): void {
  root.dataset.shortcuts = shown ? 'shown' : 'hidden';
  shortcutsToggle.setAttribute('aria-pressed', String(shown));
  const label = shown ? 'Hide keyboard shortcuts' : 'Show keyboard shortcuts';
  shortcutsToggle.setAttribute('aria-label', label);
  shortcutsToggle.title = `${label} (${shortcut('hints').keys})`;
  if (!persist) return;
  try { window.localStorage.setItem(shortcutsStorageKey, shown ? 'shown' : 'hidden'); } catch {
    // The hints still follow the choice in this window when device persistence is unavailable.
  }
  announce(shown ? 'Keyboard shortcuts shown.' : 'Keyboard shortcuts hidden.');
}
applyShortcuts(readShortcutsShown());
shortcutsToggle.addEventListener('click', () => { applyShortcuts(root.dataset.shortcuts !== 'shown', true); });

// Named for assistive technology on the controls themselves, whether or not the hints show.
const shortcutTargets: Partial<Record<ShortcutId, HTMLButtonElement>> = {
  use: navigation.use, data: navigation.data, structure: navigation.structure, surfaces: navigation.surfaces,
  history: navigation.history, health: navigation.health, agent: navigation.agent, help: navigation.help,
  back: historyBack, forward: historyForward, rail: railToggle,
};
for (const [id, button] of Object.entries(shortcutTargets)) button!.setAttribute('aria-keyshortcuts', shortcut(id as ShortcutId).aria);

/**
 * The window's shortcuts (shortcuts.ts). Each presses the control it names, so a key is
 * refused wherever the click would be -- a disabled route, a page holding unsaved typing.
 * They stand aside while a modal has hold of the window, the palette included. The Ctrl
 * keys and F1 work from inside a field, because none of them types anything there.
 */
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.repeat) return;
  const id = matchShortcut(event);
  if (id === null) return;
  if (document.querySelector('dialog[open]') !== null) return;
  event.preventDefault();
  if (id === 'palette') { openPalette(); return; }
  if (id === 'hints') { shortcutsToggle.click(); return; }
  if (id === 'file') {
    fileDetails.open = true;
    fileDetails.querySelector<HTMLButtonElement>('#file-actions button:not(:disabled)')?.focus();
    return;
  }
  const target = shortcutTargets[id];
  // A folded or hidden control is not there to press; nor is a route that is switched off.
  if (target === undefined || target.disabled || target.offsetParent === null) return;
  target.click();
});
const fileDetails = requiredElement<HTMLDetailsElement>('#file-menu');
const fileSummary = fileDetails.querySelector('summary')!;
document.addEventListener('pointerdown', event => {
  if (fileDetails.open && event.target instanceof Node && !fileDetails.contains(event.target)) fileDetails.open = false;
});
// Escape dismisses whatever sits on top: a native modal closes itself, then the file
// menu, then the innermost surface that renders a dismiss control. Escape does exactly
// what that visible Back/Cancel button does, so neither route discards more than the
// other and no surface is reachable only by mouse.
// Alt+Left and Alt+Right are what a Windows window means by back and forward, so the two
// arrows are reachable without the pointer. They stand aside for anything that has hold
// of the window: a modal, the file menu, and a field where the same keys move the caret
// or change a selection under the person's hands.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (document.querySelector('dialog[open]') !== null || fileDetails.open) return;
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement ||
      focused instanceof HTMLTextAreaElement) return;
  event.preventDefault();
  if (event.key === 'ArrowLeft') void goBack(); else void goForward();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (document.querySelector('dialog[open]') !== null) return;
  if (fileDetails.open) {
    event.preventDefault();
    fileDetails.open = false;
    fileSummary.focus();
    return;
  }
  const dismiss = content.querySelector<HTMLButtonElement>('[data-dismiss]:not(:disabled)');
  if (dismiss === null) return;
  event.preventDefault();
  dismiss.click();
});

// A Nendo file dragged onto the window, or onto the taskbar button — Windows brings
// the window forward for that and the drop lands here either way, so there is one
// mechanism and not two. The page is told about the drag by the browser and handed the
// file itself by the host, which is the only party that may look at where it came from.
const dropTarget = requiredElement<HTMLElement>('#file-drop-target');
const dropMessage = requiredElement<HTMLElement>('#file-drop-message');
requiredElement<HTMLElement>('#file-drop-icon').innerHTML = icon('open');
let dragDepth = 0;

function showDrag(fileCount: number): void {
  const hint = describeDrag(fileCount);
  if (hint === null) { hideDrag(); return; }
  dropMessage.textContent = hint.message;
  dropTarget.dataset.possible = String(hint.possible);
  dropTarget.hidden = false;
}

function hideDrag(): void {
  dragDepth = 0;
  dropTarget.hidden = true;
}

function draggedFileCount(transfer: DataTransfer | null): number {
  if (transfer === null) return 0;
  return [...transfer.items].filter(item => item.kind === 'file').length;
}

// dragenter and dragleave fire for every element the pointer crosses, so the depth
// counter is what stops the hint flickering its way across the page.
document.addEventListener('dragenter', event => {
  const files = draggedFileCount(event.dataTransfer);
  if (files === 0) return;
  // A modal has hold of the window, and the overlay would appear behind it — the
  // same rule Escape and Alt+arrow follow. Opening another file underneath a dialog
  // somebody is still answering is the part that matters.
  if (document.querySelector('dialog[open]') !== null) return;
  event.preventDefault();
  dragDepth += 1;
  showDrag(files);
});
// Always copy, even for a drag the hint has already refused. dropEffect 'none' stops
// the browser raising drop at all, and a refusal nobody can reach is a refusal that is
// never said: the person would let go over a window that had told them why and then
// watched it fall silent.
document.addEventListener('dragover', event => {
  if (dropTarget.hidden) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => {
  dragDepth -= 1;
  if (dragDepth <= 0) hideDrag();
});
document.addEventListener('drop', event => {
  if (dropTarget.hidden) return;
  event.preventDefault();
  hideDrag();
  const files = [...(event.dataTransfer?.files ?? [])];
  const verdict = judgeDrop(files.map(file => file.name));
  if (verdict.refusal !== null) { showError(verdict.refusal); return; }
  if (verdict.accept === null) return;
  void openDroppedFile(files[verdict.accept]);
});

// Dismissing rebuilds the view, so the control that opened the surface is a new
// element. Remember it by id and hand focus back, or a keyboard owner who presses
// Escape restarts from the top of the document.
let dismissReturnId: string | null = null;
content.addEventListener('click', event => {
  const button = (event.target as Element | null)?.closest('button');
  if (button == null || button.hasAttribute('data-dismiss')) return;
  dismissReturnId = button.id === '' ? null : button.id;
}, true);
content.addEventListener('click', event => {
  if ((event.target as Element | null)?.closest('[data-dismiss]') == null) return;
  const returnId = dismissReturnId;
  dismissReturnId = null;
  if (returnId !== null) document.getElementById(returnId)?.focus();
});
fileDetails.addEventListener('focusout', () => window.setTimeout(() => {
  if (!fileDetails.contains(document.activeElement)) fileDetails.open = false;
}, 0));
fileDetails.addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  fileDetails.open = true;
  const buttons = Array.from(fileDetails.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1);
  buttons[next]?.focus();
});
navigation.help.addEventListener('click', () => { void openHelp(); });
navigation.use.addEventListener('click', () => { void openWorkspaceView('use'); });
navigation.studio.addEventListener('click', () => { void openWorkspaceView('data'); });
navigation.data.addEventListener('click', () => { void openWorkspaceView('data'); });
navigation.structure.addEventListener('click', () => { void openWorkspaceView('structure'); });
navigation.surfaces.addEventListener('click', () => { void openWorkspaceView('surfaces'); });
navigation.history.addEventListener('click', () => { void openWorkspaceView('history'); });
navigation.health.addEventListener('click', () => { void refreshHealth(); });
requiredElement<HTMLButtonElement>('#stop-request').addEventListener('click', () => { void stopInFlightWork(); });
navigation.agent.addEventListener('click', () => { openAgentView(); });

function openAgentView(): void {
  if (refuseWhileDirty('opening the Agent page')) return;
  state.view = 'agent';
  state.creatingRecord = false;
  void refreshAgentStatus().then(render).catch((error: unknown) => showError(messageFor(error)));
}

/**
 * A view the host asked for, after a person clicked a Windows notification.
 *
 * The host names a view and nothing else, so this reads exactly like the person
 * having clicked that item in the navigation rail — which is what they were told
 * the notification would do. Anything more specific would have to survive the gap
 * between the notification being raised and being clicked, and a proposal can be
 * accepted or withdrawn inside it.
 */
client.onNavigate?.((route) => {
  if (route === 'agent') openAgentView();
  else if (route === 'health') void refreshHealth();
  else if (route === 'studio') void openWorkspaceView('data');
});

/**
 * The open file moved, so look again.
 *
 * The host says only that something committed, and it says it for every writer: this is
 * how a surface on screen learns that an agent wrote through MCP, which nothing in the
 * renderer's own world would otherwise show. Until this existed, a board stayed on the
 * revision it was drawn at until the person left the view and came back.
 *
 * It is a nudge, not a redraw. The event goes through the same bounded chase the tiles
 * use, so it is at most one refresh a second and never one while somebody has hold of the
 * page — an open menu replaced under the pointer is worse than a screen a second behind,
 * and we have the scars to prove it. The session snapshot is re-read first, because every
 * pending test compares against its change sequence; unsaved drafts key on the file
 * session, which a write does not change, so they survive.
 */
const fileChangedChase = createReadChase();
let follow: FollowTarget | null = null;

/**
 * Catch the view up, and keep asking until it has.
 *
 * The chase calls back after a pass and after a hold ends, and those are different
 * things: one means the reading is done, the other means it never started. So the
 * callback re-enters whenever the session is still behind what the host told us. Without
 * that, a nudge arriving while somebody had hold of the page was simply lost -- the wake
 * redrew and nothing ever re-armed the read, which the authoring gate caught by writing
 * to an open board and watching it not follow.
 */
function followTheFile(): void {
  fileChangedChase.run(
    async () => {
      state.session = await client.request<DesktopSessionView>('session.getSnapshot');
      await refreshDerived();
    },
    () => {
      rerender();
      if (stillBehind(follow, state.session.fileSessionId, state.session.manifest?.changeSequence ?? 0)) followTheFile();
    },
    (error) => showError(messageFor(error)),
    // The person's hold on the page, and their unsaved typing: a write from elsewhere
    // used to redraw a record page out from under a draft the moment its field lost
    // focus, and the draft went with nothing said (W-049). The chase asks again each
    // interval, so the view catches up the moment the draft is saved or closed.
    holdingThePage,
  );
}

// Drawn by the shell itself rather than through a render pass: it must appear while a
// request is queued behind an agent's write, which is exactly when a render cannot run.
client.onAgentActivity?.((work) => { setAgentWork(work); });

client.onFileChanged?.((changeSequence) => {
  if (!state.session.hasFile) return;
  // Our own writes already refreshed; only a sequence ahead of ours is news.
  if ((state.session.manifest?.changeSequence ?? 0) >= changeSequence) return;
  follow = followTarget(follow, state.session.fileSessionId, changeSequence);
  followTheFile();
});

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    const preference = button.dataset.themeOption ?? null;
    if (isThemePreference(preference)) applyTheme(preference, true);
  });
}
systemDark.addEventListener('change', () => {
  if (root.dataset.themePreference === 'system') applyTheme('system');
});

window.setInterval(() => {
  // A re-render replaces the panel, so never poll while the owner is editing a connection field.
  const editingConnection = content.querySelector('.agent-connection')?.contains(document.activeElement) ?? false;
  if (state.view === 'agent' && !state.actionInFlight && !editingConnection && state.session.hasFile) {
    // rerender, not render: this poll rebuilds the page every three seconds on its own
    // account, and the raw renderer puts back a page with an empty message slot. So the
    // outcome of accepting a proposal -- which is shown on this very page -- survived at
    // most one tick, and then the screen said nothing at all, with nobody having touched
    // it. That is what the owner reported of 0.8.2 reached by another route, and it is
    // why the authoring gate failed at the outcome of an acceptance about two runs in
    // five. rerender also puts the scroll position back, which this poll had been
    // throwing away every three seconds.
    // rerender, not render: this poll rebuilds the page every three seconds on its own
    // account, and the raw renderer hands back a page whose message slot is empty. So the
    // outcome of accepting a proposal -- which is shown on this very page -- survived at
    // most one tick and then the screen said nothing at all, with nobody having touched
    // it: what the owner reported of 0.8.2, reached by another route. It is also why the
    // authoring gate failed at the outcome of an acceptance about two runs in five and
    // read as a flake (F-056, F-057).
    //
    // The nav button above still uses render, because clicking Agent is somebody doing
    // the next thing. A timer is not.
    //
    // rerender also puts the scroll position back, which this poll had been throwing
    // away every three seconds.
    void refreshAgentStatus().then(rerender).catch(() => {
      // Keep the last coherent agent status if a renderer refresh races shutdown.
    });
  }
}, 3_000);

// Hand the two frame operations to the shell before anything can ask for one.
setRenderer(render, updateChrome);
// Custom views answer to the broker from their first frame, so it listens before the first render.
installViewFrames();

void initialise();
