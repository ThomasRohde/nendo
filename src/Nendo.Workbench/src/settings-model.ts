import { escapeAttribute, escapeHtml } from './format';
import type { SettingHome, SettingSection, SettingView } from './host-types';
import { icon, type IconName } from './icons';

/**
 * The Settings page's markup (ADR-0038): every setting the host's catalogue names, in sections,
 * each row saying where its value is kept. Pure, so a test renders it without a window; the
 * values come from the page, which reads each where its own control always has.
 */

export const settingSections: readonly { id: SettingSection; label: string; glyph: IconName }[] = [
  { id: 'general', label: 'General', glyph: 'settings' },
  { id: 'agents', label: 'Agents', glyph: 'agent' },
  { id: 'views', label: 'Custom views', glyph: 'surfaces' },
  { id: 'file', label: 'This file', glyph: 'file' },
];

/** The three homes, in the words every row uses. */
export const homeLabels: Record<SettingHome, string> = {
  device: 'This computer',
  here: 'This file, here',
  file: 'In the file',
};

/** What a row shows now: the value, and why it cannot change when it cannot. */
export interface SettingRowState {
  value: unknown;
  /** Why the control is unavailable; the control is disabled and this is said under it. */
  disabled?: string | null;
  /** Left out of the page, such as the approval row of a file with no automatic actions. */
  hidden?: boolean;
  /** A change to the file waiting in the bar, not yet reviewed. */
  pending?: boolean;
  /** For a link or an action: the button's words. */
  actionLabel?: string;
  /** For an action: a word on its state, such as Approved. */
  status?: string;
  /** For the icons: one row for each record type and screen. */
  icons?: IconRow[];
  /** Where a value that has layers comes from, said under the row. */
  layerNote?: string;
  /** A button that takes this computer's value away, such as Use the file's. */
  resetLabel?: string;
}

/** A record type or a screen and the icon it shows. */
export interface IconRow {
  /** The pending-change key: `icon:` and the target as JSON. */
  key: string;
  title: string;
  kind: 'Record type' | 'Screen';
  glyph: string;
  /** Chosen, guessed from the name, or neither. */
  source: 'chosen' | 'guessed' | 'neutral';
  pending: boolean;
}

/** The key of an icon change: a record type by its ID, a screen by its surface and root node. */
export function iconKey(target: { entityId: string } | { surfaceId: string; nodeId: string }): string {
  return `icon:${JSON.stringify(target)}`;
}

const iconSources = { chosen: 'Chosen', guessed: 'Guessed from the name', neutral: 'Nothing guessed' };

function iconRowsMarkup(view: SettingView, row: SettingRowState): string {
  const rows = row.icons ?? [];
  if (rows.length === 0) return `<div class="settings-row" id="${settingRowId(view.setting.id)}" data-setting-row="${escapeAttribute(view.setting.id)}"><div class="settings-row-text"><span>${escapeHtml(view.setting.title)}</span><p class="settings-help">${escapeHtml(row.disabled ?? 'This file has no record type or screen yet.')}</p></div></div>`;
  return rows.map((item, index) => {
    const id = index === 0 ? settingRowId(view.setting.id) : `${settingRowId(view.setting.id)}-${index}`;
    const labelId = `${id}-label`;
    return `<div class="settings-row${item.pending ? ' is-pending' : ''}" id="${id}" data-setting-row="${escapeAttribute(view.setting.id)}">
    <div class="settings-row-text"><div class="settings-row-title"><span id="${labelId}">${escapeHtml(item.title)}</span><span class="settings-home" data-home="file">${homeLabels.file}</span>${item.pending ? '<span class="settings-pending">Not reviewed</span>' : ''}</div>
    <p class="settings-help">${escapeHtml(`${item.kind} · ${iconSources[item.source]}`)}</p></div>
    <div class="settings-row-control"><span class="settings-icon-preview">${item.glyph}</span><button type="button" class="secondary-button" aria-describedby="${labelId}" data-setting-icon="${escapeAttribute(item.key)}"${row.disabled ? ' disabled' : ''}>Change</button></div>
  </div>`;
  }).join('');
}

export interface SettingsPage {
  settings: SettingView[];
  section: SettingSection;
  query: string;
  state: (view: SettingView) => SettingRowState;
  /** How many changes to the file wait for review. */
  pending: number;
  fileName: string | null;
  /** The apps the file carries that declare settings, each a section of its own. */
  apps?: { id: SettingSection; label: string }[];
}

export function settingsQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function sectionOf(settings: SettingView[], id: string): SettingSection | null {
  return settings.find(view => view.setting.id === id)?.setting.section ?? null;
}

/** Whether a setting answers a search: its title, help, group, section or home. */
export function matchesSetting(view: SettingView, query: string): boolean {
  const q = settingsQuery(query);
  if (q === '') return true;
  const { setting } = view;
  const section = settingSections.find(item => item.id === setting.section)?.label ?? '';
  return [setting.title, setting.help ?? '', setting.group, section, homeLabels[setting.home]]
    .some(text => text.toLocaleLowerCase().includes(q));
}

/** The rows to show, grouped: one section's groups, or every match of a search under its section's name. */
export function settingGroups(page: Pick<SettingsPage, 'settings' | 'section' | 'query' | 'state'>): { title: string; rows: SettingView[] }[] {
  const searching = settingsQuery(page.query) !== '';
  const groups: { title: string; rows: SettingView[] }[] = [];
  for (const view of page.settings) {
    if (page.state(view).hidden) continue;
    if (searching ? !matchesSetting(view, page.query) : view.setting.section !== page.section) continue;
    const section = settingSections.find(item => item.id === view.setting.section)?.label ?? view.setting.group;
    const title = searching && section !== view.setting.group ? `${section} · ${view.setting.group}` : view.setting.group;
    const group = groups.find(item => item.title === title);
    if (group) group.rows.push(view); else groups.push({ title, rows: [view] });
  }
  return groups;
}

export function settingRowId(id: string): string {
  // An ID a selector can name as it stands: an app's setting carries colons and dots.
  return `setting-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function controlMarkup(view: SettingView, row: SettingRowState, labelId: string): string {
  const { setting } = view;
  const disabled = row.disabled ? ' disabled' : '';
  const id = escapeAttribute(setting.id);
  switch (setting.kind) {
    case 'toggle': {
      const on = row.value === true;
      return `<span class="settings-switch-state" aria-hidden="true">${on ? 'On' : 'Off'}</span><button type="button" class="settings-switch" role="switch" aria-checked="${on}" aria-labelledby="${labelId}" data-setting-toggle="${id}"${disabled}><span class="switch-glyph"></span></button>`;
    }
    case 'choice':
      return `<div class="settings-choice" role="radiogroup" aria-labelledby="${labelId}">${(setting.options ?? []).map(option => {
        const chosen = option.value === row.value;
        return `<button type="button" role="radio" aria-checked="${chosen}" data-setting-choice="${id}" data-value="${escapeAttribute(option.value)}"${disabled}>${escapeHtml(option.label)}</button>`;
      }).join('')}</div>`;
    case 'number':
      return `<input class="settings-number" type="number" inputmode="decimal" step="any" aria-labelledby="${labelId}" data-setting-number="${id}"${setting.minimum === null ? '' : ` min="${setting.minimum}"`}${setting.maximum === null ? '' : ` max="${setting.maximum}"`} value="${escapeAttribute(String(row.value ?? ''))}"${disabled} />${setting.unit ? `<span class="settings-unit">${escapeHtml(setting.unit)}</span>` : ''}`;
    case 'text':
      return `<input class="settings-text" type="text" autocomplete="off" aria-labelledby="${labelId}" data-setting-text="${id}"${setting.maximum === null ? '' : ` maxlength="${setting.maximum}"`} value="${escapeAttribute(String(row.value ?? ''))}"${disabled} />`;
    case 'icons':
    case 'link':
    case 'action':
      return `${row.status ? `<span class="settings-status">${escapeHtml(row.status)}</span>` : ''}<button type="button" class="secondary-button" aria-describedby="${labelId}" data-setting-${setting.kind}="${id}"${disabled}>${escapeHtml(row.actionLabel ?? 'Open')}</button>`;
  }
}

export function settingRowMarkup(view: SettingView, row: SettingRowState): string {
  const { setting } = view;
  if (setting.kind === 'icons') return iconRowsMarkup(view, row);
  const rowId = settingRowId(setting.id);
  const labelId = `${rowId}-label`;
  const note = view.override ? `${view.override} sets this for the running Nendo.` : row.disabled ?? null;
  const layers = row.layerNote ? `<p class="settings-help">${escapeHtml(row.layerNote)}${row.resetLabel ? ` <button type="button" class="text-button" data-setting-reset="${escapeAttribute(setting.id)}">${escapeHtml(row.resetLabel)}</button>` : ''}</p>` : '';
  return `<div class="settings-row${row.pending ? ' is-pending' : ''}" id="${rowId}" data-setting-row="${escapeAttribute(setting.id)}">
    <div class="settings-row-text"><div class="settings-row-title"><span id="${labelId}">${escapeHtml(setting.title)}</span><span class="settings-home" data-home="${setting.home}">${escapeHtml(homeLabels[setting.home])}</span>${row.pending ? '<span class="settings-pending">Not reviewed</span>' : ''}</div>
    ${setting.help ? `<p class="settings-help">${escapeHtml(setting.help)}</p>` : ''}${layers}${note ? `<p class="settings-note">${escapeHtml(note)}</p>` : ''}</div>
    <div class="settings-row-control">${controlMarkup(view, view.override ? { ...row, disabled: row.disabled ?? view.override } : row, labelId)}</div>
  </div>`;
}

export function settingsPageMarkup(page: SettingsPage): string {
  const searching = settingsQuery(page.query) !== '';
  const groups = settingGroups(page);
  const app = (page.apps ?? []).find(item => item.id === page.section);
  const section = settingSections.find(item => item.id === page.section) ?? (app ? { id: app.id, label: app.label, glyph: 'box' as IconName } : settingSections[0]);
  const count = groups.reduce((total, group) => total + group.rows.length, 0);
  const heading = searching ? 'Settings that match' : section.label;
  const sectionButton = (item: { id: string; label: string; glyph: IconName }): string => `<button type="button" class="settings-section" data-settings-section="${escapeAttribute(item.id)}"${!searching && item.id === page.section ? ' aria-current="page"' : ''}>${icon(item.glyph)}<span>${escapeHtml(item.label)}</span></button>`;
  const apps = page.apps ?? [];
  const index = settingSections.map(sectionButton).join('')
    + (apps.length === 0 ? '' : `<p class="settings-index-label">Apps in this file</p>${apps.map(item => sectionButton({ ...item, glyph: 'box' })).join('')}`);
  const bar = page.pending > 0 ? `<div class="settings-changes" role="status"><p><strong>${page.pending === 1 ? '1 change to the file' : `${page.pending} changes to the file`}</strong> <span>${escapeHtml(`They apply to everyone who opens ${page.fileName ?? 'this file'} once you accept them.`)}</span></p><button type="button" class="secondary-button" data-settings-discard>Discard</button><button type="button" class="primary-button" data-settings-review>Review</button></div>` : '';
  const body = groups.length === 0
    ? `<p class="settings-empty">${searching ? 'No setting matches.' : 'Nothing to set here without a file.'}</p>`
    : groups.map(group => `<section class="settings-group" aria-label="${escapeAttribute(group.title)}"><h3>${escapeHtml(group.title)}</h3><div class="settings-rows">${group.rows.map(view => settingRowMarkup(view, page.state(view))).join('')}</div></section>`).join('');
  return `<div class="settings-page">
    <aside class="settings-index" aria-label="Settings sections"><label for="settings-search">Find a setting</label><input id="settings-search" type="search" autocomplete="off" placeholder="Theme, port, views…" value="${escapeAttribute(page.query)}" /><nav aria-label="Sections">${index}</nav></aside>
    <section class="settings-list" aria-labelledby="settings-heading"><h2 id="settings-heading" class="visually-hidden" tabindex="-1">${escapeHtml(heading)}</h2>${bar}${searching ? `<p class="settings-count" role="status">${count === 1 ? '1 setting matches.' : `${count} settings match.`}</p>` : ''}${body}</section>
  </div>`;
}

/** The proposal for the waiting changes: one mutation each, so each can be undone on its own. */
export function settingsProposal(changes: ReadonlyMap<string, string>, definitionRevision: number): Record<string, unknown> | null {
  if (changes.size === 0) return null;
  const id = crypto.randomUUID().replaceAll('-', '');
  const mutations = [...changes].map(([setting, typed], index) => {
    if (setting.startsWith('app:')) {
      const [, packageId, ...rest] = setting.split(':');
      const settingId = rest.join(':');
      return { idempotencyKey: `settings-${id}-${index}`, description: `Set ${settingId} for ${packageId}`,
        operations: [{ operationId: `settings-${id}-${index}`, operationType: 'package.setSetting',
          payload: { packageId, settingId, value: JSON.parse(typed), expectedDefinitionRevision: definitionRevision + index } }] };
    }
    if (setting.startsWith('icon:')) {
      const target = JSON.parse(setting.slice(5)) as { entityId?: string; surfaceId?: string; nodeId?: string };
      const chosen = typed === '' ? null : typed;
      const description = chosen === null ? 'Show the guessed icon' : `Show the ${chosen} icon`;
      const operation = target.entityId !== undefined
        ? { operationType: 'schema.setEntityIcon', payload: { entityId: target.entityId, icon: chosen, expectedDefinitionRevision: definitionRevision + index } }
        : chosen === null
          ? { operationType: 'ui.removeProperty', payload: { surfaceId: target.surfaceId, nodeId: target.nodeId, propertyName: 'icon' } }
          : { operationType: 'ui.setProperty', payload: { surfaceId: target.surfaceId, nodeId: target.nodeId, propertyName: 'icon', value: chosen } };
      return { idempotencyKey: `settings-${id}-${index}`, description, operations: [{ operationId: `settings-${id}-${index}`, ...operation }] };
    }
    const text = typed.trim() === '' ? null : typed.trim();
    const purpose = setting === 'file.purpose';
    const description = purpose ? 'Say what this file is for' : 'Name a new file of this application';
    return { idempotencyKey: `settings-${id}-${index}`, description,
      operations: [{ operationId: `settings-${id}-${index}`, operationType: purpose ? 'application.setPurpose' : 'application.setNewFileLabel',
        payload: { [purpose ? 'purpose' : 'label']: text, expectedDefinitionRevision: definitionRevision + index } }] };
  });
  return { proposalId: `proposal-${id}`, title: changes.size === 1 ? mutations[0].description : 'Change this file\'s settings', mutations };
}
