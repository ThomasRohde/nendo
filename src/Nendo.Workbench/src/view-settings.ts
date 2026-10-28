import { prepareApplication } from './actions';
import { fileScopedClearable, state } from './app-state';
import { deferWhileBusy } from './busy-queue';
import { client } from './client';
import { refuseWhileDirty } from './draft-guard';
import { openAboutFile } from './file-actions';
import { iconPictureUrl } from './file-look';
import { escapeHtml, messageFor } from './format';
import type { AgentAccessMode, LaunchableAgents, SettingSection, SettingView, SettingsView, ViewAgentAccess } from './host-types';
import { loadsWebPictures, setLoadsWebPictures } from './media-model';
import { type IconRow, type SettingRowState, iconKey, purposeCount, sectionOf, settingRowId, settingsPageMarkup, settingsProposal } from './settings-model';
import { allowsPersonal, allowsShared, type AppSettingDeclaration } from './app-settings-model';
import { packageSettings } from './app-settings';
import type { DesktopSessionView, SettingDescriptor } from './host-types';
import { knownIcon } from './chosen-icons';
import { chosenEntityIcon, fileViews, viewGlyph, viewIcon } from './file-view-model';
import { chooseIcon } from './icon-picker';
import type { IconName } from './icons';
import { typeGlyph, typeIcon } from './type-icons';
import { viewTitle } from './view-frame-markup';
import { announce, applyTheme, clearError, content, isThemePreference, navigation, readPreference, requiredElement, rerender, showError } from './shell';
import { saveAgentSettings, setAgentMode } from './view-agent';
import { assistantAccessChanged } from './view-assistant';
import { setBehaviourApproval } from './view-health';
import { openCustomViews, setViewSwitch } from './view-packages';

/**
 * Settings (ADR-0038): every setting of Nendo in one page, drawn by the host like Studio, so it
 * opens without a file, read-only and in safe mode. The rows come from the host's settings
 * catalogue; each value is read and changed through the method its own control has always used,
 * so the Agent page, Studio, Health, the status line and the tray change the same values.
 */

let described: SettingsView | null = null;
let launchable: LaunchableAgents | null = null;
let loading: Promise<void> | null = null;
/** Why the catalogue could not be read, until Try again. Never read again by itself, or a refusal would loop. */
let unreadable: string | null = null;
/** Changes to the file typed here and not yet reviewed, by setting ID. */
const pending = fileScopedClearable(new Map<string, string>());
/** The purpose while its text area is open, kept across a redraw; null while it is read. */
let purposeDraft: string | null = null;
fileScopedClearable({ clear(): void { purposeDraft = null; } });
// The launch choices are the open file's: another file reads its own.
fileScopedClearable({ clear(): void { launchable = null; } });

/** Open Settings, at one setting when a link names it (`settings/<id>`). */
export async function openSettings(settingId = ''): Promise<void> {
  if (deferWhileBusy(() => { void openSettings(settingId); })) return;
  if (refuseWhileDirty('opening Settings')) return;
  state.settingsRowId = settingId;
  state.settingsQuery = '';
  state.view = 'settings';
  state.creatingRecord = false;
  await loadSettings();
  if (settingId !== '' && described) state.settingsSection = sectionOf(described.settings, settingId) ?? state.settingsSection;
  rerender();
}

/** Reads the catalogue and the values that live with the agents; the rest are in the session. */
async function loadSettings(): Promise<void> {
  loading ??= (async () => {
    try {
      described = await client.request<SettingsView>('settings.describe');
      unreadable = null;
      const agents = described.settings.some(view => view.setting.section === 'agents');
      if (agents && state.session.hasFile) {
        try { state.agentStatus = await client.request('agent.getStatus'); } catch { /* The rows say they cannot be read. */ }
        try { launchable = await client.request<LaunchableAgents>('agentSession.list'); } catch { launchable = null; }
      }
    } catch (error) {
      unreadable = messageFor(error);
    } finally {
      loading = null;
    }
  })();
  await loading;
}

const noFile = 'Open a file to choose this.';

function readOnlyReason(): string | null {
  return state.session.capabilities.mutate ? null : 'This file is open read-only, so nothing in it can change.';
}

/** The apps of the open file that declare settings, and a row for each setting (ADR-0038). */
function appSections(): { id: SettingSection; label: string }[] {
  return (state.session.extensions?.packages ?? []).filter(item => (item.settings?.length ?? 0) > 0)
    .map(item => ({ id: `app:${item.packageId}` as SettingSection, label: item.title }));
}

function appSettingViews(): SettingView[] {
  return (state.session.extensions?.packages ?? []).flatMap(item => (item.settings ?? []).map((declaration): SettingView => {
    const setting: SettingDescriptor = {
      id: `app:${item.packageId}:${declaration.id}`, section: `app:${item.packageId}`, group: item.title, title: declaration.title,
      help: declaration.help, home: declaration.layers === 'personal' ? 'device' : 'file', kind: declaration.type,
      store: declaration.layers === 'personal' ? 'views\\app-settings.json' : 'definition: package.setSetting',
      options: declaration.options, minimum: declaration.min, maximum: declaration.max, unit: declaration.unit,
      windowsOnly: false, needsFile: true,
    };
    return { setting, value: null, override: null };
  }));
}

/** The package and the declaration an app row names. */
function appTarget(id: string): { packageId: string; declaration: AppSettingDeclaration; title: string } | null {
  if (!id.startsWith('app:')) return null;
  for (const item of state.session.extensions?.packages ?? [])
    for (const declaration of item.settings ?? [])
      if (id === `app:${item.packageId}:${declaration.id}`) return { packageId: item.packageId, declaration, title: item.title };
  return null;
}

function shown(value: unknown, declaration: AppSettingDeclaration): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (declaration.type === 'choice') return declaration.options?.find(option => option.value === value)?.label ?? String(value);
  return `${String(value)}${declaration.unit ? ` ${declaration.unit}` : ''}`;
}

function appRowState(id: string): SettingRowState {
  const target = appTarget(id);
  if (target === null) return { value: null, hidden: true };
  const resolved = packageSettings(target.packageId).find(item => item.declaration.id === target.declaration.id);
  if (resolved === undefined) return { value: null, hidden: true };
  const { declaration } = target;
  if (!allowsPersonal(declaration)) {
    // Kept in the file: a change waits in the bar with the file's other changes.
    const waiting = pending.get(id);
    return { value: waiting === undefined ? resolved.value : JSON.parse(waiting), pending: waiting !== undefined, disabled: readOnlyReason() };
  }
  if (!allowsShared(declaration)) return { value: resolved.value };
  const fileValue = resolved.shared !== undefined ? resolved.shared : declaration.default;
  return { value: resolved.value,
    layerNote: resolved.personal !== undefined ? `Yours, on this computer. The file says ${shown(fileValue, declaration)}.`
      : resolved.shared !== undefined ? 'The file\'s value, for everyone who opens it. A change here is yours alone.' : 'The app\'s default. A change here is yours alone.',
    resetLabel: resolved.personal !== undefined ? 'Use the file\'s' : undefined };
}

/** What a row shows now, read where the setting's own control reads it. */
function rowState(view: SettingView): SettingRowState {
  const { setting } = view;
  if (setting.id.startsWith('app:')) return appRowState(setting.id);
  if (setting.needsFile && !state.session.hasFile) return { value: null, disabled: noFile, actionLabel: 'Open' };
  const agent = state.agentStatus;
  switch (setting.id) {
    case 'appearance.theme': return { value: isThemePreference(document.documentElement.dataset.themePreference ?? null) ? document.documentElement.dataset.themePreference : readPreference() };
    case 'appearance.shortcutHints': return { value: document.documentElement.dataset.shortcuts === 'shown' };
    case 'media.webPictures': return { value: loadsWebPictures() };
    case 'window.closeToTray':
    case 'diagnostics.recordFailures': return { value: view.value };
    case 'agents.access': return { value: agent?.mode ?? 'off', disabled: agent ? null : 'Agent access could not be read.' };
    case 'agents.port': return { value: agent?.portPreference ?? '', disabled: !agent ? 'Agent access could not be read.' : agent.fixedPort ? null : 'Used only while each file keeps its port.' };
    case 'agents.fixedPort': return { value: agent?.fixedPort ?? false, disabled: agent ? null : noFile };
    case 'agents.leaseExpiry': return { value: agent?.leaseExpiry ?? false, disabled: agent ? null : noFile };
    case 'agents.leaseExpirySeconds': return { value: agent?.leaseExpirySeconds ?? '', disabled: !agent ? noFile : agent.leaseExpiry ? null : 'Used only while an idle lease ends.' };
    case 'agents.viewMessages': return { value: launchable?.viewAccess ?? 'ask', disabled: launchable ? null : noFile };
    case 'agents.startInRepository': return { value: launchable?.startInRepository === true, disabled: launchable ? null : 'Launching agents is not available here.' };
    case 'agents.options': return { value: null, actionLabel: 'Open Agent page', disabled: state.session.hasFile ? null : noFile };
    case 'views.run': return { value: state.session.extensions?.deviceEnabled ?? true };
    case 'views.runThisFile': return { value: state.session.extensions?.fileEnabled ?? true };
    case 'views.developmentLinks': return { value: null, actionLabel: 'Open Custom views' };
    case 'file.look': return { value: null, actionLabel: 'Change look', disabled: readOnlyReason() };
    case 'file.purpose':
    case 'file.newFileLabel': {
      const kept = (setting.id === 'file.purpose' ? state.session.manifest?.purpose : state.session.manifest?.newFileLabel) ?? '';
      return { value: pending.get(setting.id) ?? kept, pending: pending.has(setting.id), disabled: readOnlyReason() };
    }
    case 'file.icons': return { value: null, icons: iconRows(), disabled: readOnlyReason() };
    case 'file.automaticActions': {
      const trust = state.session.behaviourTrust;
      if (!trust?.requiresApproval) return { value: null, hidden: true };
      return { value: trust.isApproved, status: trust.isApproved ? 'Approved here' : 'Not approved', actionLabel: trust.isApproved ? 'Withdraw approval' : 'Approve' };
    }
    default: return { value: view.value, disabled: 'This Nendo cannot change this here.' };
  }
}

export function renderSettings(): void {
  if (described === null) {
    if (unreadable !== null) {
      content.innerHTML = `<div class="settings-empty" role="alert"><p>${escapeHtml(`Settings could not be read. ${unreadable}`)}</p><button type="button" class="secondary-button" data-settings-retry>Try again</button></div>`;
      content.querySelector('[data-settings-retry]')?.addEventListener('click', () => {
        unreadable = null;
        void loadSettings().then(() => { if (state.view === 'settings') rerender(); });
      });
      return;
    }
    content.innerHTML = '<p class="settings-empty" role="status">Reading settings…</p>';
    if (loading === null) void loadSettings().then(() => { if (state.view === 'settings') rerender(); });
    return;
  }
  const apps = appSections();
  if (state.settingsSection.startsWith('app:') && !apps.some(app => app.id === state.settingsSection)) state.settingsSection = 'file';
  content.innerHTML = settingsPageMarkup({ settings: [...described.settings, ...appSettingViews()], section: state.settingsSection, query: state.settingsQuery,
    state: rowState, pending: pending.size, fileName: state.session.fileName, apps, fileCard: fileCard() });
  wireSettings();
  if (state.settingsRowId !== '') {
    const row = content.querySelector<HTMLElement>(`#${settingRowId(state.settingsRowId)}`);
    state.settingsRowId = '';
    if (row) {
      row.classList.add('is-target');
      row.scrollIntoView({ block: 'center' });
      row.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')?.focus();
    }
  }
}

/** The file's icon as the window draws it, and the purpose being edited. */
function fileCard(): { look: { tone: string; letter: string; pictureUrl: string | null } | null; draft: string | null } {
  const look = state.session.hasFile ? state.session.look ?? null : null;
  return { look: look === null ? null : { tone: look.tone, letter: look.letter, pictureUrl: iconPictureUrl(look.icon, state.session.mediaOrigin) }, draft: purposeDraft };
}

function setting(id: string): SettingView | undefined {
  return described?.settings.find(view => view.setting.id === id);
}

function wireSettings(): void {
  const search = requiredElement<HTMLInputElement>('#settings-search');
  search.addEventListener('input', () => {
    state.settingsQuery = search.value;
    const at = search.selectionStart;
    rerender();
    // The redraw replaced the field: carry on typing where the person was.
    const again = content.querySelector<HTMLInputElement>('#settings-search');
    again?.focus();
    if (again && at !== null) again.setSelectionRange(at, at);
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-settings-section]')) button.addEventListener('click', () => {
    state.settingsSection = button.dataset.settingsSection as SettingSection;
    state.settingsQuery = '';
    rerender();
    content.querySelector<HTMLElement>('.settings-index [aria-current]')?.focus();
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-setting-toggle]')) button.addEventListener('click', () => {
    void changeSetting(button.dataset.settingToggle!, button.getAttribute('aria-checked') !== 'true');
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-setting-choice]')) button.addEventListener('click', () => {
    void changeSetting(button.dataset.settingChoice!, button.dataset.value!);
  });
  for (const input of content.querySelectorAll<HTMLInputElement>('[data-setting-number]')) input.addEventListener('change', () => {
    const value = Number(input.value);
    if (!Number.isInteger(value)) { showError('Enter a whole number.'); return; }
    void changeSetting(input.dataset.settingNumber!, value);
  });
  for (const input of content.querySelectorAll<HTMLInputElement>('[data-setting-text]')) input.addEventListener('change', () => {
    keepPending(input.dataset.settingText!, input.value);
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-setting-link]')) button.addEventListener('click', () => {
    followLink(button.dataset.settingLink!);
  });
  wirePurpose();
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-setting-reset]')) button.addEventListener('click', () => {
    void changeSetting(button.dataset.settingReset!, null);
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-setting-icon]')) button.addEventListener('click', () => {
    void pickIcon(button.dataset.settingIcon!);
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-setting-action]')) button.addEventListener('click', () => {
    void setBehaviourApproval(state.session.behaviourTrust?.isApproved !== true).then(() => rerender());
  });
  content.querySelector('[data-settings-discard]')?.addEventListener('click', () => {
    pending.clear();
    announce('Changes to the file discarded.');
    rerender();
  });
  content.querySelector('[data-settings-review]')?.addEventListener('click', () => { void reviewChanges(); });
}

/** Changes one setting through the method its own control uses, then shows it again. */
async function changeSetting(id: string, value: unknown): Promise<void> {
  clearError();
  const app = appTarget(id);
  if (app !== null) {
    await changeAppSetting(id, app, value);
    return;
  }
  try {
    switch (id) {
      case 'appearance.theme':
        if (typeof value === 'string' && isThemePreference(value)) applyTheme(value, true);
        break;
      case 'appearance.shortcutHints':
        if ((document.documentElement.dataset.shortcuts === 'shown') !== value) document.querySelector<HTMLButtonElement>('#shortcuts-toggle')?.click();
        break;
      case 'media.webPictures':
        setLoadsWebPictures(value === true);
        announce(value === true ? 'Pictures from the web are shown.' : 'Pictures from the web are not loaded.');
        break;
      case 'window.closeToTray':
      case 'diagnostics.recordFailures':
        described = await client.request<SettingsView>('settings.set', { id, value });
        announce(`${setting(id)?.setting.title ?? 'Setting'}: ${value === true ? 'on' : 'off'}.`);
        break;
      case 'agents.access': await setAgentMode(value as AgentAccessMode); break;
      case 'agents.fixedPort': await saveAgentSettings({ fixedPort: value === true }); break;
      case 'agents.leaseExpiry': await saveAgentSettings({ leaseExpiry: value === true }); break;
      case 'agents.leaseExpirySeconds': await saveAgentSettings({ leaseExpirySeconds: value as number }); break;
      case 'agents.port': await saveAgentSettings({ port: value as number }); break;
      case 'agents.viewMessages':
        launchable = await client.request<LaunchableAgents>('agentSession.setViewAccess', { access: value });
        assistantAccessChanged(value as ViewAgentAccess);
        announce(`Views may message the agent: ${setting(id)?.setting.options?.find(option => option.value === value)?.label ?? value}.`);
        break;
      case 'agents.startInRepository':
        launchable = await client.request<LaunchableAgents>('agentSession.setStartIn', { repository: value === true });
        announce(value === true ? 'Agents start in this file\'s repository from the next launch.' : 'Agents start in an empty folder from the next launch.');
        break;
      case 'views.run': await setViewSwitch('device', value === true); break;
      case 'views.runThisFile': await setViewSwitch('file', value === true); break;
      default: return;
    }
  } catch (error) {
    showError(messageFor(error));
  }
  if (state.view !== 'settings') return;
  rerender();
  // The redraw replaced the control: keep the person on it.
  const row = content.querySelector<HTMLElement>(`#${settingRowId(id)}`);
  (row?.querySelector<HTMLElement>('[aria-checked="true"][role="radio"]') ?? row?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])'))?.focus();
}

/**
 * An app's setting: this computer's value is kept at once, where the setting allows one; a value
 * kept only in the file waits in the bar for review.
 */
async function changeAppSetting(id: string, app: { packageId: string; declaration: AppSettingDeclaration; title: string }, value: unknown): Promise<void> {
  if (!allowsPersonal(app.declaration)) {
    const resolved = packageSettings(app.packageId).find(item => item.declaration.id === app.declaration.id);
    if (resolved !== undefined && JSON.stringify(resolved.value) === JSON.stringify(value)) pending.delete(id);
    else pending.set(id, JSON.stringify(value));
    rerender();
    content.querySelector<HTMLElement>(`#${settingRowId(id)} button:not([disabled]), #${settingRowId(id)} input:not([disabled])`)?.focus();
    return;
  }
  try {
    const result = await client.request<DesktopSessionView | { session: DesktopSessionView }>('package.settings.set',
      { packageId: app.packageId, settingId: app.declaration.id, value: value ?? null });
    state.session = 'session' in result ? result.session : result;
    announce(value === null ? `${app.declaration.title}: the file's value again.` : `${app.declaration.title}: ${shown(value, app.declaration)}.`);
  } catch (error) {
    showError(messageFor(error));
  }
  if (state.view !== 'settings') return;
  rerender();
  content.querySelector<HTMLElement>(`#${settingRowId(id)} [aria-checked="true"][role="radio"], #${settingRowId(id)} button:not([disabled]), #${settingRowId(id)} input:not([disabled])`)?.focus();
}

/** The purpose's card: Edit purpose opens a text area, Done puts the change in the bar, Cancel or Escape leaves it. */
function wirePurpose(): void {
  const kept = (): string => pending.get('file.purpose') ?? state.session.manifest?.purpose ?? '';
  const focusEdit = (): void => { content.querySelector<HTMLButtonElement>('[data-purpose-edit]')?.focus(); };
  content.querySelector('[data-purpose-edit]')?.addEventListener('click', () => {
    purposeDraft = kept();
    rerender();
    const area = content.querySelector<HTMLTextAreaElement>('[data-purpose-text]');
    area?.focus();
    area?.setSelectionRange(area.value.length, area.value.length);
  });
  const cancel = (): void => { purposeDraft = null; rerender(); focusEdit(); };
  const done = (): void => {
    const typed = purposeDraft ?? kept();
    purposeDraft = null;
    keepPending('file.purpose', typed);
    focusEdit();
  };
  const area = content.querySelector<HTMLTextAreaElement>('[data-purpose-text]');
  area?.addEventListener('input', () => {
    purposeDraft = area.value;
    const count = content.querySelector('#settings-purpose-count');
    if (count) count.textContent = purposeCount(area.value.length, area.maxLength > 0 ? area.maxLength : 4000);
  });
  area?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    else if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); done(); }
  });
  content.querySelector('[data-purpose-cancel]')?.addEventListener('click', cancel);
  content.querySelector('[data-purpose-done]')?.addEventListener('click', done);
}

/** A change to the file waits in the bar until the person reviews it with the others. */
function keepPending(id: string, typed: string): void {
  const kept = (id === 'file.purpose' ? state.session.manifest?.purpose : state.session.manifest?.newFileLabel) ?? '';
  if (typed.trim() === kept.trim()) pending.delete(id); else pending.set(id, typed);
  rerender();
  content.querySelector<HTMLInputElement>(`[data-setting-text="${id}"]`)?.focus();
}

async function reviewChanges(): Promise<void> {
  const manifest = state.session.manifest;
  const payload = manifest ? settingsProposal(pending, manifest.definitionRevision) : null;
  if (payload === null) return;
  const opened = await prepareApplication({ actionLabel: 'Review', applicationName: state.session.fileName ?? '', proposalPayload: payload }, 'settings');
  if (opened) pending.clear();
}

/** What a record type or a screen shows, and where its icon came from. */
interface IconTarget { key: string; title: string; kind: IconRow['kind']; stored: string | null; guessed: IconName; neutral: boolean; glyph: (chosen: string | null) => string }

function iconTargets(): IconTarget[] {
  const types = state.session.entities.filter(entity => entity.retired !== true).map((entity): IconTarget => {
    const guess = typeIcon(entity.displayName);
    return { key: iconKey({ entityId: entity.entityId }), title: entity.displayName, kind: 'Record type', stored: knownIcon(chosenEntityIcon(entity.entityId)),
      guessed: guess ?? 'box', neutral: guess === null, glyph: chosen => typeGlyph(entity.displayName, chosen) };
  });
  const views = (state.compilation?.isValid ? fileViews() : []).flatMap((view): IconTarget[] => {
    const surfaceId = state.session.uiNodes.find(node => node.nodeId === view.semanticId)?.surfaceId;
    if (surfaceId === undefined) return [];
    const guess = typeIcon(viewTitle(view));
    return [{ key: iconKey({ surfaceId, nodeId: view.semanticId }), title: viewTitle(view), kind: 'Screen', stored: knownIcon(view.properties.icon),
      guessed: viewIcon(view), neutral: guess === null, glyph: chosen => viewGlyph({ ...view, properties: { ...view.properties, icon: chosen } }) }];
  });
  return [...types, ...views];
}

function iconRows(): IconRow[] {
  return iconTargets().map(target => {
    const waiting = pending.get(target.key);
    const shown = waiting === undefined ? target.stored : (waiting === '' ? null : waiting);
    return { key: target.key, title: target.title, kind: target.kind, glyph: target.glyph(shown), pending: waiting !== undefined,
      source: shown !== null ? 'chosen' : target.neutral ? 'neutral' : 'guessed' };
  });
}

/** Opens the picker for one record type or screen; the choice waits in the bar with the file's other changes. */
async function pickIcon(key: string): Promise<void> {
  const target = iconTargets().find(item => item.key === key);
  if (target === undefined) return;
  const waiting = pending.get(key);
  const chosen = await chooseIcon({ title: `Icon for ${target.title}`, current: waiting === undefined ? target.stored : (waiting === '' ? null : waiting), guessed: target.guessed });
  if (chosen === undefined) { content.querySelector<HTMLElement>(`[data-setting-icon="${CSS.escape(key)}"]`)?.focus(); return; }
  if ((chosen ?? null) === target.stored) pending.delete(key); else pending.set(key, chosen ?? '');
  announce(chosen === null ? `${target.title} shows its guessed icon once you review the change.` : `${target.title} shows ${chosen} once you review the change.`);
  rerender();
  content.querySelector<HTMLElement>(`[data-setting-icon="${CSS.escape(key)}"]`)?.focus();
}

/**
 * From the navigation: right-click a record type or a screen, choose its icon, and review that one
 * change straight away (ADR-0038).
 */
export async function changeIconFromNavigation(target: { entityId: string } | { nodeId: string }): Promise<void> {
  if (!state.session.capabilities.mutate) { showError('This file is open read-only, so its icons cannot change.'); return; }
  const key = 'entityId' in target ? iconKey({ entityId: target.entityId })
    : iconTargets().find(item => item.kind === 'Screen' && item.key.includes(JSON.stringify(target.nodeId)))?.key;
  const found = iconTargets().find(item => item.key === key);
  if (found === undefined) return;
  const chosen = await chooseIcon({ title: `Icon for ${found.title}`, current: found.stored, guessed: found.guessed });
  if (chosen === undefined || (chosen ?? null) === found.stored) return;
  const manifest = state.session.manifest;
  const payload = manifest ? settingsProposal(new Map([[found.key, chosen ?? '']]), manifest.definitionRevision) : null;
  if (payload !== null) await prepareApplication({ actionLabel: 'Review', applicationName: state.session.fileName ?? '', proposalPayload: payload }, 'use');
}

function followLink(id: string): void {
  if (id === 'agents.options') navigation.agent.click();
  else if (id === 'views.developmentLinks') void openCustomViews();
  else if (id === 'file.look') openAboutFile();
}
