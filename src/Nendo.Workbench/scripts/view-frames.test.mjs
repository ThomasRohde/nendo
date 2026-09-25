import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// Custom views as the page draws them (ADR-0013): the frame's attributes, the placeholder a
// record page and a screen draw, and what a placeholder says when its view cannot run. Each
// is read from the function the Workbench draws it with.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const markup = await bundleOf('src/view-frame-markup.ts');
const { pageFormBody } = await bundleOf('src/page-markup.ts');
const { surfaceBodyMarkup } = await bundleOf('src/surface-markup.ts');

const origin = 'https://org-example-glance-3f2a9c01be.example';
const pkg = { packageId: 'org.example.glance', title: 'Glance', version: '1.0.0', entryPoint: 'index.html', description: null, origin, fileCount: 3, totalBytes: 14682 };
const running = { run: true, offReason: null, deviceEnabled: true, fileEnabled: true, packages: [pkg] };
const spec = { viewId: 'view.glance', kind: 'extensionRecordsSurface', placement: 'screen', title: 'Glance', packageId: 'org.example.glance', entityId: 'tasks', recordId: null };

test('a view frame is sandboxed without top navigation, named by its mount, and starts at its entry point', () => {
  const mountId = markup.newMountId();
  assert.match(mountId, /^[0-9a-f]{12}$/);
  assert.notEqual(markup.newMountId(), mountId, 'Two mounts were given the same ID.');
  const attributes = Object.fromEntries(markup.frameAttributes({ mountId, origin, entryPoint: 'app/index.html', title: 'Glance <b>' }));
  assert.match(attributes.name, /^nendo-view-[0-9a-f]{12}$/);
  assert.equal(attributes.name, `nendo-view-${mountId}`);
  const sandbox = attributes.sandbox.split(' ');
  assert.deepEqual(sandbox, ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox',
    'allow-downloads', 'allow-modals', 'allow-pointer-lock', 'allow-presentation']);
  assert.ok(sandbox.every(token => !token.startsWith('allow-top-navigation')), `A view may navigate the Workbench away: ${attributes.sandbox}`);
  assert.equal(attributes.allow, 'clipboard-read; clipboard-write; fullscreen; web-share; autoplay; encrypted-media; picture-in-picture; geolocation');
  assert.equal(attributes.loading, 'lazy');
  assert.equal(attributes.src, `${origin}/app/index.html`);
  assert.equal(attributes.title, 'Glance <b>');
  // The source is set last, once the sandbox is on the element.
  assert.equal(markup.frameAttributes({ mountId, origin, entryPoint: 'index.html', title: 'x' }).at(-1)[0], 'src');
  const drawn = markup.frameMarkup({ mountId, origin, entryPoint: 'my view/start page.html', title: 'Glance <b>' });
  assert.match(drawn, /src="https:\/\/org-example-glance-3f2a9c01be\.example\/my%20view\/start%20page\.html"/);
  assert.match(drawn, /title="Glance &lt;b&gt;"/);
  assert.doesNotMatch(drawn, /allow-top-navigation/);
});

test('only an origin under .example is ever framed', () => {
  assert.ok(markup.isViewOrigin(origin));
  for (const other of ['https://app.nendo.local', 'http://org-example.example', 'https://a.b.example', 'https://example', 'https://x.example/path', 'https://-x.example'])
    assert.equal(markup.isViewOrigin(other), false, other);
  assert.equal(markup.viewNotice({ ...running, packages: [{ ...pkg, origin: 'https://app.nendo.local' }] }, 'org.example.glance', 'desktop').kind, 'unservable');
});

test('a view runs only when views are on and its package is in the file, and says why otherwise', () => {
  assert.equal(markup.viewNotice(running, 'org.example.glance', 'desktop').kind, 'run');
  assert.deepEqual(markup.viewNotice(running, 'org.example.missing', 'desktop'), { kind: 'missing' });
  assert.deepEqual(markup.viewNotice(running, 'org.example.glance', 'preview'), { kind: 'preview' });
  assert.deepEqual(markup.viewNotice(null, 'org.example.glance', 'desktop'), { kind: 'unavailable' });
  for (const reason of ['device', 'file', 'health', 'recovery'])
    assert.deepEqual(markup.viewNotice({ ...running, run: false, offReason: reason }, 'org.example.missing', 'desktop'), { kind: 'off', reason },
      'A switch that is off comes before a missing package.');

  const said = (notice) => markup.viewNoticeMarkup(notice, spec);
  for (const reason of ['device', 'file']) {
    const text = said({ kind: 'off', reason });
    assert.match(text, /Studio → Surfaces → Custom views/);
    assert.match(text, /<button type="button" class="secondary-button" data-view-settings>Open Custom views<\/button>/);
  }
  assert.match(said({ kind: 'off', reason: 'device' }), /Custom views are off on this device\./);
  assert.match(said({ kind: 'off', reason: 'file' }), /Custom views are off for this file on this device\./);
  assert.match(said({ kind: 'off', reason: 'health' }), /data-view-health>Open Health</);
  // After Restart without custom views the switches still read on; running views again is its own step.
  const recovery = said({ kind: 'off', reason: 'recovery' });
  assert.match(recovery, /restarted without them/);
  assert.match(recovery, /<button type="button" class="secondary-button" data-view-resume>Run custom views again<\/button>/);
  assert.doesNotMatch(recovery, /data-view-settings/);
  const recoveryPanel = markup.customViewsPanelMarkup({ ...running, run: false, offReason: 'recovery' }, 'Planner.nendo');
  assert.match(recoveryPanel, /data-view-resume>Run custom views again</);
  assert.match(recoveryPanel, /data-view-switch="device" aria-pressed="true"/);
  assert.doesNotMatch(markup.customViewsPanelMarkup(running, null), /data-view-resume/);
  const missing = said({ kind: 'missing' });
  assert.match(missing, /<strong>org\.example\.glance<\/strong> is not in this file/);
  // A proposal, so the read-only sweep switches it off with every other edit.
  assert.match(missing, /<button type="button" class="primary-button" data-action data-view-import>Add package to file…<\/button>/);
  assert.match(said({ kind: 'preview' }), /Custom views run in Nendo Desktop, not in this preview\. In Nendo, Glance runs here from the org\.example\.glance package in this file\./);
  assert.match(said({ kind: 'unavailable' }), /not available in this session/);
});

test('a stopped or unresponsive view is covered by what happened, with Reload', () => {
  const unresponsive = markup.viewOverlayMarkup('unresponsive');
  assert.match(unresponsive, /This view is not responding/);
  assert.match(unresponsive, /data-view-stop>Stop</);
  assert.match(unresponsive, /data-view-reload>Reload</);
  const crashed = markup.viewOverlayMarkup('crashed');
  assert.match(crashed, /This view stopped/);
  assert.match(crashed, /data-view-reload>Reload</);
  assert.doesNotMatch(crashed, /data-view-stop/);
  assert.match(markup.viewOverlayMarkup('stopped'), /data-view-reload>Reload</);
});

test('a frame is kept across redraws only for the same view, record, file and package content', () => {
  const key = markup.mountKey(spec, 'session-one', pkg);
  assert.equal(markup.mountKey({ ...spec }, 'session-one', { ...pkg }), key);
  assert.notEqual(markup.mountKey({ ...spec, recordId: 'r2' }, 'session-one', pkg), key);
  assert.notEqual(markup.mountKey(spec, 'session-two', pkg), key);
  assert.notEqual(markup.mountKey(spec, 'session-one', { ...pkg, totalBytes: 14683 }), key, 'Changed code kept the old frame.');
  assert.notEqual(markup.mountKey(spec, 'session-one', { ...pkg, contentDigest: '0123456789abcdef' }), key,
    'An edit of the same size kept the old frame.');
});

const field = (id, name) => ({ semanticId: id, displayName: name, storageKind: 'text', required: false, options: [] });
const node = (id, kind, properties, children = []) => ({ semanticId: id, automationTarget: id, kind, properties, children });
const panel = node('schedule', 'extensionRecordPanel', { title: 'Schedule <b>', packageId: 'org.nendo.gantt' });
const pagePlan = {
  contractVersion: 3,
  entity: { semanticId: 'tasks', displayName: 'Task', fields: [field('title', 'Title'), field('owner', 'Owner')] },
  records: [],
  surfaces: [node('page', 'detailSurface', { entityId: 'tasks' }, [
    node('page-title', 'fieldBinding', { fieldId: 'title' }),
    panel,
    node('page-owner', 'fieldBinding', { fieldId: 'owner' }),
  ])],
};
const record = { semanticId: 't1', version: 3, values: { title: 'Task one', owner: 'Ada' } };

test('a record page draws its view where it was authored, for this record, and starts nothing itself', () => {
  const body = pageFormBody(pagePlan, record, true);
  const at = body.indexOf('data-view-id="schedule"');
  assert.ok(at > 0, body);
  assert.ok(body.indexOf('name="title"') < at && at < body.indexOf('name="owner"'), 'The view is not between the two fields it was authored between.');
  assert.match(body, /<section class="view-mount is-panel" data-view-mount data-view-id="schedule" data-view-kind="extensionRecordPanel" data-view-placement="recordPage"/);
  assert.match(body, /data-view-record="t1"/);
  assert.match(body, /data-view-entity="tasks"/);
  assert.match(body, /data-view-package="org\.nendo\.gantt"/);
  assert.match(body, /<div class="view-stage" data-view-stage><\/div>/);
  // The title is text, never markup, and nothing on the placeholder is a frame yet.
  assert.ok(!body.includes('Schedule <b>'), body);
  assert.match(body, /Schedule &lt;b&gt;/);
  assert.doesNotMatch(body, /<iframe/);
  assert.doesNotMatch(body, /Show view|Allow this view|Install package/);
});

test('a record not yet saved says why there is no view', () => {
  const body = pageFormBody(pagePlan, record, false);
  assert.ok(!body.includes('data-view-mount'), body);
  assert.match(body, /data-view-unsaved/);
  assert.match(body, /Save this record to show its custom view\./);
});

test('a custom view screen is one placeholder that fills the surface, with no steps before it runs', () => {
  const plan = {
    contractVersion: 3,
    entity: { semanticId: 'work', displayName: 'Work item', fields: [] },
    records: [],
    surfaces: [node('graph.work', 'extensionGraphSurface', { title: 'Work dependencies', entityId: 'work', packageId: 'org.nendo.work-dependencies' })],
  };
  const body = surfaceBodyMarkup(plan);
  assert.match(body, /^<section class="view-mount is-screen" data-view-mount data-view-id="graph\.work" data-view-kind="extensionGraphSurface" data-view-placement="screen" data-view-title="Work dependencies" data-view-package="org\.nendo\.work-dependencies" data-view-entity="work" data-view-record="" aria-label="Work dependencies"><div class="view-stage" data-view-stage><\/div><\/section>$/);
  assert.doesNotMatch(body, /<button/);
});

test('Studio’s Custom views panel shows the two switches and each package, and marks what edits the file', () => {
  const panelMarkup = markup.customViewsPanelMarkup({ ...running, fileEnabled: false, run: false, offReason: 'file' }, 'Planner.nendo');
  assert.match(panelMarkup, /data-view-switch="device" aria-pressed="true"/);
  assert.match(panelMarkup, /data-view-switch="file" aria-pressed="false"/);
  assert.match(panelMarkup, /On this device, for Planner\.nendo/);
  assert.match(panelMarkup, /Custom views are off for this file on this device\. Turn both switches on to run them\./);
  assert.match(panelMarkup, /<h3>Glance<\/h3><p>org\.example\.glance · version 1\.0\.0 · 3 files · 14\.3 KB<\/p>/);
  // Import and Remove are proposals: the read-only sweep switches them off. The switches and
  // Export change nothing in the file and stay usable.
  assert.match(panelMarkup, /<button type="button" class="secondary-button" data-action data-package-remove="org\.example\.glance">Remove…<\/button>/);
  assert.match(panelMarkup, /<button type="button" class="secondary-button" data-action data-package-import>Import package…<\/button>/);
  assert.match(panelMarkup, /<button type="button" class="secondary-button" data-package-export="org\.example\.glance">Export…<\/button>/);
  assert.doesNotMatch(panelMarkup, /data-action data-view-switch|data-view-switch="[a-z]+" data-action/);
  assert.match(markup.customViewsPanelMarkup({ ...running, packages: [] }, null), /No custom-view packages in this file yet\./);
  assert.match(markup.customViewsPanelMarkup(null, null), /not available in this session/);
});
