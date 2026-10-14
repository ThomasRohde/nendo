import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/studio-column-layout.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { columnLayoutKey, cleanColumnLayout, readColumnLayout, writeColumnLayout } = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
test('device layout contains only known unique columns and permitted properties', () => {
  assert.deepEqual(cleanColumnLayout([{ id: 'name', hidden: true, pinned: 'left', arbitrary: 'no' }, { id: 'missing' },
    { id: 'name', pinned: 'right' }, { id: 'amount', pinned: 'invalid', hidden: 'false' }], ['name', 'amount']),
  [{ id: 'name', hidden: true, pinned: 'left' }, { id: 'amount', hidden: false, pinned: null }]);
  assert.notEqual(columnLayoutKey('a.b', 'c'), columnLayoutKey('a', 'b.c'));
  assert.deepEqual(readColumnLayout({ getItem() { throw Error('refused'); } }, 'key', ['name']), []);
  assert.doesNotThrow(() => writeColumnLayout({ setItem() { throw Error('refused'); } }, 'key', []));
});
