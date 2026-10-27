import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

const { iconSet, iconGroups } = await bundleOf('src/icon-set.ts');
const { findIcons, knownIcon, setIconMarkup } = await bundleOf('src/chosen-icons.ts');
const { typeGlyph } = await bundleOf('src/type-icons.ts');
const { icon } = await bundleOf('src/icons.ts');
const { iconKey, settingRowMarkup, settingsProposal } = await bundleOf('src/settings-model.ts');

// The Engine refuses a name that is not in src/Nendo.Engine/icon-set.json and publishes that file as
// nendo://application/icons; the Workbench draws from its own copy. They must name the same icons.
test('the Workbench draws exactly the icons the Engine accepts, with the same groups and words', () => {
  const shared = JSON.parse(readFileSync(new URL('../../Nendo.Engine/icon-set.json', import.meta.url), 'utf8')).icons;
  assert.ok(iconSet.length >= 500, `${iconSet.length} icons`);
  assert.deepEqual(iconSet.map(({ name, group, words }) => ({ name, group, words })), shared);
  assert.deepEqual([...new Set(iconSet.map(item => item.group))].sort(), [...iconGroups].sort());
});

test('each icon is only outline shapes', () => {
  for (const item of iconSet) {
    const tags = [...item.drawing.matchAll(/<([a-z]+)/g)].map(match => match[1]);
    assert.ok(tags.length > 0 && tags.every(tag => ['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'].includes(tag)), `${item.name}: ${tags}`);
    assert.doesNotMatch(item.drawing, /\son[a-z]+=|href|<script|style=/i, item.name);
  }
});

test('the picker finds an icon by a search word that is not its name, within a group or across all', () => {
  const people = findIcons('people', null).map(item => item.name);
  assert.ok(people.includes('users'), `people: ${people.slice(0, 10)}`);
  assert.ok(findIcons('peo', null).some(item => item.name === 'users'), 'the start of a word is enough');
  assert.ok(findIcons('', 'Time').every(item => item.group === 'Time'));
  assert.ok(findIcons('', 'Time').some(item => item.name === 'calendar'));
  assert.deepEqual(findIcons('nothing-is-called-this', null), []);
});

// A record type whose name suggests nothing drew its letters on a coloured tile; the owner asked
// for those to go (2026-10-27). It draws a box, and a chosen icon wins over any guess.
test('a record type draws its chosen icon, else its guessed one, else a box, and never a tile of letters', () => {
  assert.equal(typeGlyph('Decisions'), icon('box'), 'a name that suggests nothing');
  assert.doesNotMatch(typeGlyph('Findings'), /type-tile/);
  assert.equal(typeGlyph('Decisions', 'scale'), setIconMarkup('scale'), 'a chosen icon');
  assert.equal(typeGlyph('Tasks', 'not-in-the-set'), typeGlyph('Tasks'), 'a name this Nendo does not know is no choice');
  assert.equal(knownIcon('scale'), 'scale');
  assert.equal(knownIcon(42), null);
});

test('icon changes become one operation each: the record type\'s, or the screen\'s property', () => {
  const type = iconKey({ entityId: 'nd.decision' });
  const chosen = iconKey({ surfaceId: 'surface.view.garden', nodeId: 'view.garden' });
  const cleared = iconKey({ surfaceId: 'surface.view.board', nodeId: 'view.board' });
  const proposal = settingsProposal(new Map([[type, 'scale'], [chosen, 'sprout'], [cleared, '']]), 12);
  const operations = proposal.mutations.map(mutation => mutation.operations[0]);
  assert.deepEqual(operations.map(operation => [operation.operationType, operation.payload]), [
    ['schema.setEntityIcon', { entityId: 'nd.decision', icon: 'scale', expectedDefinitionRevision: 12 }],
    ['ui.setProperty', { surfaceId: 'surface.view.garden', nodeId: 'view.garden', propertyName: 'icon', value: 'sprout' }],
    ['ui.removeProperty', { surfaceId: 'surface.view.board', nodeId: 'view.board', propertyName: 'icon' }],
  ]);
  assert.equal(proposal.mutations[2].description, 'Show the guessed icon');
});

test('Settings draws a row for each record type and screen, in the file, with Change', () => {
  const view = { setting: { id: 'file.icons', section: 'file', group: 'Icons', title: 'Icons', help: null, home: 'file', kind: 'icons', store: 'x',
    options: null, minimum: null, maximum: null, unit: null, windowsOnly: false, needsFile: true }, value: null, override: null };
  const markup = settingRowMarkup(view, { value: null, icons: [
    { key: iconKey({ entityId: 'nd.decision' }), title: 'Decisions', kind: 'Record type', glyph: icon('box'), source: 'neutral', pending: false },
    { key: iconKey({ entityId: 'nd.work' }), title: 'Work items', kind: 'Record type', glyph: setIconMarkup('briefcase'), source: 'chosen', pending: true },
  ] });
  assert.equal([...markup.matchAll(/data-setting-icon=/g)].length, 2);
  assert.match(markup, /Decisions<\/span><span class="settings-home" data-home="file">In the file<\/span>/);
  assert.match(markup, /Record type · Nothing guessed/);
  assert.match(markup, /class="settings-row is-pending".*Work items.*Not reviewed.*Record type · Chosen/s);
  assert.match(markup, /id="setting-file-icons"/, 'the first row carries the address a link opens');
});
