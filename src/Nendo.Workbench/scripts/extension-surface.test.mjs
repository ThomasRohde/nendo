import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// The custom view's own screen, rendered by the function the app renders it with. The owner
// met an "Open graph" button drawn in the browser's default chrome beside two Workbench pills
// (2026-09-21): the button carried no class at all, so nothing but the eye could see it.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { surfaceBodyMarkup } = await bundleOf('src/surface-markup.ts');

const plan = {
  contractVersion: 3,
  entity: { semanticId: 'work', displayName: 'Work item', fields: [] },
  records: [],
  surfaces: [{ semanticId: 'graph.work', automationTarget: 'graph.work', kind: 'extensionGraphSurface', properties: { title: 'Work dependencies' }, children: [] }],
};

const buttons = (markup) => [...markup.matchAll(/<button\s[^>]*id="([^"]+)"[^>]*>/g)]
  .map(match => ({ id: match[1], classes: (/class="([^"]*)"/.exec(match[0]) ?? [, ''])[1].split(' ').filter(Boolean) }));

test('every control on a custom view screen is drawn as a Workbench button', () => {
  const markup = surfaceBodyMarkup(plan);
  const drawn = buttons(markup);
  assert.deepEqual(drawn.map(button => button.id).sort(), ['extension-next', 'extension-studio', 'manage-extension']);
  for (const button of drawn)
    assert.ok(button.classes.includes('primary-button') || button.classes.includes('secondary-button'),
      `${button.id} carries no Workbench button class: ${JSON.stringify(button.classes)}`);
  // The next step is the primary one: the other two are the ways out of it.
  assert.deepEqual(drawn.find(button => button.id === 'extension-next').classes, ['primary-button']);
  assert.equal(drawn.filter(button => button.classes.includes('secondary-button')).length, 2);
});

test('the screen names the view and says where the records stay', () => {
  const markup = surfaceBodyMarkup(plan);
  assert.match(markup, /<h2 id="extension-title">Work dependencies<\/h2>/);
  assert.match(markup, /id="extension-status"/);
  assert.match(markup, /editable in Studio/);
});
