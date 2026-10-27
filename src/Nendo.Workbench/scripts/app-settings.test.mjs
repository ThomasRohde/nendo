import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

const { fits, resolveSettings, settingValues } = await bundleOf('src/app-settings-model.ts');
const { settingsProposal } = await bundleOf('src/settings-model.ts');

const declare = (id, type, layers, extra = {}) => ({ id, title: id, help: null, type, layers, default: null, options: null, min: null, max: null, unit: null, maxLength: null, ...extra });
const typeface = declare('typeface', 'choice', 'personal', { default: 'serif', options: [{ value: 'serif', label: 'Serif' }, { value: 'sans', label: 'Sans' }] });
const size = declare('textSize', 'number', 'both', { default: 17, min: 12, max: 24, unit: 'px' });
const house = declare('quotes', 'choice', 'shared', { default: 'curly', options: [{ value: 'curly', label: 'Curly' }, { value: 'straight', label: 'Straight' }] });

test('a value is the default, then the file\'s, then this computer\'s, each only where its layers allow', () => {
  const resolved = resolveSettings([typeface, size, house], { typeface: 'sans', textSize: 18, quotes: 'straight' }, { textSize: 20, quotes: 'curly' });
  assert.deepEqual(settingValues(resolved), { typeface: 'serif', textSize: 20, quotes: 'straight' },
    'a personal setting ignores the file; both takes the person over the file; a shared one ignores this computer');
  assert.deepEqual(resolved.map(item => item.source), ['default', 'personal', 'file']);
  assert.equal(resolved[1].shared, 18, 'the file\'s value is kept beside the person\'s, for Use the file\'s');
});

test('a stored value that no longer fits its declaration is passed over', () => {
  const resolved = resolveSettings([size, typeface], { textSize: 99 }, { textSize: 'big', typeface: 'mono' });
  assert.deepEqual(settingValues(resolved), { textSize: 17, typeface: 'serif' });
  assert.equal(fits(size, 12), true);
  assert.equal(fits(size, 11.5), false);
  assert.equal(fits(declare('note', 'text', 'personal', { maxLength: 3 }), 'abcd'), false);
  assert.equal(fits(declare('on', 'toggle', 'personal'), 'true'), false);
});

test('an app\'s value in the file waits in the bar as package.setSetting', () => {
  const proposal = settingsProposal(new Map([['app:org.example.manus:quotes', JSON.stringify('straight')]]), 4);
  assert.deepEqual(proposal.mutations[0].operations[0].operationType, 'package.setSetting');
  assert.deepEqual(proposal.mutations[0].operations[0].payload, { packageId: 'org.example.manus', settingId: 'quotes', value: 'straight', expectedDefinitionRevision: 4 });
});

test('an app setting\'s row has an ID a selector can name', async () => {
  const { settingRowId } = await bundleOf('src/settings-model.ts');
  assert.match(settingRowId('app:org.example.reader:typeface'), /^[A-Za-z0-9_-]+$/);
  assert.equal(settingRowId('views.run'), 'setting-views-run');
});
