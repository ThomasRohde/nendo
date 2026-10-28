import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

const { fileCardMarkup, homeLabels, matchesSetting, purposeParagraphs, sectionOf, settingGroups, settingRowMarkup, settingsPageMarkup, settingsProposal } = await bundleOf('src/settings-model.ts');

const setting = (id, section, group, title, home, kind, extra = {}) => ({ setting: { id, section, group, title, help: null, home, kind, store: 'x',
  options: null, minimum: null, maximum: null, unit: null, windowsOnly: false, needsFile: false, ...extra }, value: null, override: null });
const settings = [
  setting('appearance.theme', 'general', 'Appearance', 'Theme', 'device', 'choice', { options: [{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }] }),
  setting('window.closeToTray', 'general', 'Window', 'Close keeps Nendo in the notification area', 'device', 'toggle'),
  setting('agents.access', 'agents', 'This file', 'Agent access', 'here', 'choice', { options: [{ value: 'off', label: 'Off' }, { value: 'inspect', label: 'Inspect' }] }),
  setting('agents.port', 'agents', 'This file', 'Port for this file', 'here', 'number', { minimum: 1024, maximum: 65535 }),
  setting('file.purpose', 'file', 'Identity', 'Purpose', 'file', 'text', { maximum: 4000 }),
  setting('file.automaticActions', 'file', 'Automatic actions', 'Automatic actions', 'here', 'action'),
];
const state = view => ({ value: view.setting.id === 'appearance.theme' ? 'dark' : view.setting.id === 'window.closeToTray' ? true : 'Notes', hidden: view.setting.id === 'file.automaticActions' });

test('every row says where its value is kept, in the three homes\' words', () => {
  assert.deepEqual(homeLabels, { device: 'This computer', here: 'This file, here', file: 'In the file' });
  for (const view of settings) {
    const markup = settingRowMarkup(view, { value: null });
    assert.match(markup, new RegExp(`data-home="${view.setting.home}">${homeLabels[view.setting.home]}<`), view.setting.id);
  }
});

test('a section shows its own groups; a search shows matches from every section under the section\'s name', () => {
  assert.deepEqual(settingGroups({ settings, section: 'agents', query: '', state }).map(group => group.title), ['This file']);
  const found = settingGroups({ settings, section: 'general', query: 'this file', state });
  assert.deepEqual(found.map(group => group.title), ['Agents · This file', 'This file · Identity'], 'the home and the section answer a search too');
  assert.equal(matchesSetting(settings[1], 'notification'), true);
  assert.equal(matchesSetting(settings[1], 'port'), false);
  assert.equal(sectionOf(settings, 'agents.port'), 'agents');
  // A hidden row is left out, such as the approval of a file with no automatic actions.
  assert.deepEqual(settingGroups({ settings, section: 'file', query: '', state }).map(group => group.title), ['Identity']);
});

test('each control says its state to assistive technology', () => {
  const theme = settingRowMarkup(settings[0], { value: 'dark' });
  assert.match(theme, /role="radiogroup" aria-labelledby="setting-appearance-theme-label"/);
  assert.match(theme, /role="radio" aria-checked="true" data-setting-choice="appearance.theme" data-value="dark"/);
  assert.match(theme, /role="radio" aria-checked="false" data-setting-choice="appearance.theme" data-value="system"/);
  const close = settingRowMarkup(settings[1], { value: true });
  assert.match(close, /role="switch" aria-checked="true"/);
  const port = settingRowMarkup(settings[3], { value: 41787 });
  assert.match(port, /min="1024" max="65535" value="41787"/);
  assert.match(settingRowMarkup(settings[4], { value: 'Notes' }), /maxlength="4000" value="Notes"/);
});

test('a row that cannot change says why, and an environment variable makes it read-only', () => {
  const disabled = settingRowMarkup(settings[3], { value: 41787, disabled: 'Used only while each file keeps its port.' });
  assert.match(disabled, / disabled \/>/);
  assert.match(disabled, /<p class="settings-note">Used only while each file keeps its port\.<\/p>/);
  const overridden = settingRowMarkup({ ...settings[1], override: 'NENDO_DESKTOP_CLOSE_ACTION' }, { value: false });
  assert.match(overridden, /data-setting-toggle="window.closeToTray" disabled/);
  assert.match(overridden, /NENDO_DESKTOP_CLOSE_ACTION sets this for the running Nendo\./);
});

test('this file opens on a card with its icon and its purpose as paragraphs, edited in a text area', () => {
  const look = setting('file.look', 'file', 'Identity', 'Look', 'file', 'link');
  const withLook = [look, ...settings];
  const card = { look: { tone: 'blue', letter: 'P', pictureUrl: null }, draft: null };
  const page = settingsPageMarkup({ settings: withLook, section: 'file', query: '', state: view => view.setting.id === 'file.look' ? { value: null, actionLabel: 'Change look' }
    : { value: 'One.\n\nTwo, after a blank line.' }, pending: 0, fileName: 'Planner.nendo', fileCard: card });
  assert.match(page, /class="settings-file-card" id="setting-file-purpose" data-setting-row="file\.purpose"/);
  assert.match(page, /<span class="look-badge" data-tone="blue">P<\/span>/);
  assert.match(page, /<strong id="setting-file-purpose-label">Planner\.nendo<\/strong>/);
  assert.match(page, /<div class="settings-purpose"><p>One\.<\/p><p>Two, after a blank line\.<\/p><\/div>/);
  assert.match(page, /data-setting-link="file\.look">Change look<\/button>/);
  assert.doesNotMatch(page, /data-setting-row="file\.look"|data-setting-text="file\.purpose"/);
  const editing = fileCardMarkup(settings[4], { value: 'One.' }, null, { ...card, draft: 'One. Two.' }, 'Planner.nendo');
  assert.match(editing, /<textarea id="settings-purpose" class="settings-purpose-text" data-purpose-text rows="8" maxlength="4000"[^>]*>One\. Two\.<\/textarea>/);
  assert.match(editing, /<span id="settings-purpose-count" class="settings-purpose-count">9 of 4,000<\/span>/);
  assert.doesNotMatch(editing, /data-purpose-edit/);
  const closed = fileCardMarkup(settings[4], { value: '', disabled: 'Open a file to choose this.' }, null, { look: null, draft: null }, null);
  assert.match(closed, /No file open.*data-purpose-edit disabled.*Nothing says what this file is for yet\..*<p class="settings-note">Open a file to choose this\.<\/p>/s);
  assert.deepEqual(purposeParagraphs('a\n  \n\nb\nc\n'), ['a', 'b\nc']);
});

test('changes to the file wait in one bar with Review and Discard', () => {
  const none = settingsPageMarkup({ settings, section: 'file', query: '', state, pending: 0, fileName: 'Notes.nendo' });
  assert.doesNotMatch(none, /settings-changes/);
  const two = settingsPageMarkup({ settings, section: 'file', query: '', state, pending: 2, fileName: 'Notes.nendo' });
  assert.match(two, /<strong>2 changes to the file<\/strong> <span>They apply to everyone who opens Notes\.nendo once you accept them\.<\/span>/);
  assert.match(two, /data-settings-discard>Discard<\/button><button type="button" class="primary-button" data-settings-review>Review<\/button>/);
  assert.match(settingRowMarkup(settings[4], { value: 'Novel', pending: true }), /class="settings-row is-pending".*Not reviewed/s);
});

test('the waiting changes become one proposal with an operation each, at consecutive revisions', () => {
  assert.equal(settingsProposal(new Map(), 7), null);
  const proposal = settingsProposal(new Map([['file.purpose', '  A novel in progress '], ['file.newFileLabel', '']]), 7);
  assert.equal(proposal.title, 'Change this file\'s settings');
  assert.equal(proposal.mutations.length, 2);
  assert.deepEqual(proposal.mutations.map(mutation => mutation.operations[0].operationType), ['application.setPurpose', 'application.setNewFileLabel']);
  assert.deepEqual(proposal.mutations[0].operations[0].payload, { purpose: 'A novel in progress', expectedDefinitionRevision: 7 });
  assert.deepEqual(proposal.mutations[1].operations[0].payload, { label: null, expectedDefinitionRevision: 8 }, 'an empty box takes the value away');
  assert.equal(settingsProposal(new Map([['file.purpose', 'x']]), 3).title, 'Say what this file is for');
});

// The catalogue is the host's; the page reads and changes each row. A setting added to the
// catalogue without a case here would show a row that cannot be read or changed.
test('the page reads every setting the host\'s catalogue names', () => {
  const catalogue = readFileSync(new URL('../../Nendo.Session/SettingsCatalogue.cs', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/view-settings.ts', import.meta.url), 'utf8');
  // Only the function that reads a row: the change handler names many of the same IDs.
  const page = source.slice(source.indexOf('function rowState('), source.indexOf('export function renderSettings('));
  assert.ok(page.length > 0, 'rowState was found');
  const constants = Object.fromEntries([...catalogue.matchAll(/const string (\w+) = "([\w.]+)";/g)].map(match => [match[1], match[2]]));
  const ids = [...catalogue.matchAll(/new\((?:"([\w.]+)"|(\w+)), "(general|agents|views|file)"/g)].map(match => match[1] ?? constants[match[2]]);
  assert.ok(ids.length >= 18, `the catalogue was read: ${ids.length} settings`);
  for (const id of ids) assert.ok(page.includes(`case '${id}':`), `Settings does not read ${id}.`);
});

// The preview draws Settings from its own copy of the catalogue; a setting added to the host's
// alone would be missing from every preview and shell-lane check.
test('the preview offers the same settings as the host, in the same order', async () => {
  const catalogue = readFileSync(new URL('../../Nendo.Session/SettingsCatalogue.cs', import.meta.url), 'utf8');
  const constants = Object.fromEntries([...catalogue.matchAll(/const string (\w+) = "([\w.]+)";/g)].map(match => [match[1], match[2]]));
  const ids = [...catalogue.matchAll(/new\((?:"([\w.]+)"|(\w+)), "(general|agents|views|file)"/g)].map(match => match[1] ?? constants[match[2]]);
  const { previewCatalogue } = await bundleOf('src/preview-settings.ts');
  assert.deepEqual(previewCatalogue.map(setting => setting.id), ids);
});
