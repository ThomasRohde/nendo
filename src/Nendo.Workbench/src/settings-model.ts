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
}

export interface SettingsPage {
  settings: SettingView[];
  section: SettingSection;
  query: string;
  state: (view: SettingView) => SettingRowState;
  /** How many changes to the file wait for review. */
  pending: number;
  fileName: string | null;
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
    const section = settingSections.find(item => item.id === view.setting.section)?.label ?? '';
    const title = searching ? `${section} · ${view.setting.group}` : view.setting.group;
    const group = groups.find(item => item.title === title);
    if (group) group.rows.push(view); else groups.push({ title, rows: [view] });
  }
  return groups;
}

export function settingRowId(id: string): string {
  return `setting-${id.replaceAll('.', '-')}`;
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
      return `<input class="settings-number" type="number" inputmode="numeric" step="1" aria-labelledby="${labelId}" data-setting-number="${id}"${setting.minimum === null ? '' : ` min="${setting.minimum}"`}${setting.maximum === null ? '' : ` max="${setting.maximum}"`} value="${escapeAttribute(String(row.value ?? ''))}"${disabled} />${setting.unit ? `<span class="settings-unit">${escapeHtml(setting.unit)}</span>` : ''}`;
    case 'text':
      return `<input class="settings-text" type="text" autocomplete="off" aria-labelledby="${labelId}" data-setting-text="${id}"${setting.maximum === null ? '' : ` maxlength="${setting.maximum}"`} value="${escapeAttribute(String(row.value ?? ''))}"${disabled} />`;
    case 'link':
    case 'action':
      return `${row.status ? `<span class="settings-status">${escapeHtml(row.status)}</span>` : ''}<button type="button" class="secondary-button" aria-describedby="${labelId}" data-setting-${setting.kind}="${id}"${disabled}>${escapeHtml(row.actionLabel ?? 'Open')}</button>`;
  }
}

export function settingRowMarkup(view: SettingView, row: SettingRowState): string {
  const { setting } = view;
  const rowId = settingRowId(setting.id);
  const labelId = `${rowId}-label`;
  const note = view.override ? `${view.override} sets this for the running Nendo.` : row.disabled ?? null;
  return `<div class="settings-row${row.pending ? ' is-pending' : ''}" id="${rowId}" data-setting-row="${escapeAttribute(setting.id)}">
    <div class="settings-row-text"><div class="settings-row-title"><span id="${labelId}">${escapeHtml(setting.title)}</span><span class="settings-home" data-home="${setting.home}">${escapeHtml(homeLabels[setting.home])}</span>${row.pending ? '<span class="settings-pending">Not reviewed</span>' : ''}</div>
    ${setting.help ? `<p class="settings-help">${escapeHtml(setting.help)}</p>` : ''}${note ? `<p class="settings-note">${escapeHtml(note)}</p>` : ''}</div>
    <div class="settings-row-control">${controlMarkup(view, view.override ? { ...row, disabled: row.disabled ?? view.override } : row, labelId)}</div>
  </div>`;
}

export function settingsPageMarkup(page: SettingsPage): string {
  const searching = settingsQuery(page.query) !== '';
  const groups = settingGroups(page);
  const section = settingSections.find(item => item.id === page.section) ?? settingSections[0];
  const count = groups.reduce((total, group) => total + group.rows.length, 0);
  const heading = searching ? 'Settings that match' : section.label;
  const index = settingSections.map(item => `<button type="button" class="settings-section" data-settings-section="${item.id}"${!searching && item.id === page.section ? ' aria-current="page"' : ''}>${icon(item.glyph)}<span>${escapeHtml(item.label)}</span></button>`).join('');
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
    const text = typed.trim() === '' ? null : typed.trim();
    const purpose = setting === 'file.purpose';
    const description = purpose ? 'Say what this file is for' : 'Name a new file of this application';
    return { idempotencyKey: `settings-${id}-${index}`, description,
      operations: [{ operationId: `settings-${id}-${index}`, operationType: purpose ? 'application.setPurpose' : 'application.setNewFileLabel',
        payload: { [purpose ? 'purpose' : 'label']: text, expectedDefinitionRevision: definitionRevision + index } }] };
  });
  return { proposalId: `proposal-${id}`, title: changes.size === 1 ? mutations[0].description : 'Change this file\'s settings', mutations };
}
