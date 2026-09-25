async (page) => {
  const root = '__NENDO_REPOSITORY__';
  const errors = [];
  // Errors in the view's own frame reach the page too, uncaught rejections included.
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  await page.setViewportSize({ width: 960, height: 640 });
  // The broker page frames the package from another origin and answers it as the Workbench would.
  await page.goto('__BROKER_URL__');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => window.broker.viewOrigin);

  // The file the graph reads: tasks with a name and a status whose option IDs are not their
  // names, and dependency records whose two references point at tasks.
  const field = (fieldId, displayName, storageKind, extra = {}) => ({ fieldId, displayName, storageKind, required: false,
    presentation: null, calculated: false, expression: null, choices: [], reference: null, scale: null, ...extra });
  const record = (entityId, recordId, values, labels = {}) => ({ entityId, recordId, version: 1, values, exact: {}, labels, calculated: {} });
  const statuses = { Doing: 'status-doing', Next: 'status-next' };
  const fixture = ({ nodes, edges }) => {
    const names = new Map(nodes.map(node => [node.id, node.label]));
    return {
      context: { viewId: 'dependencyGraph', kind: 'extensionGraphSurface', placement: 'screen', title: 'Dependencies', entityId: 'task', recordId: null,
        bindings: { labelFieldId: 'taskName', statusFieldId: 'taskStatus', edgeEntityId: 'dependency', sourceFieldId: 'blocker', targetFieldId: 'blocked', fields: [], filters: [] } },
      schema: { entities: [
        { entityId: 'task', displayName: 'Task', fields: [field('taskName', 'Name', 'text'), field('taskStatus', 'Status', 'text', { presentation: 'singleChoice',
          choices: Object.entries(statuses).map(([displayName, id]) => ({ id, displayName, retired: false, tone: null })) })] },
        { entityId: 'dependency', displayName: 'Dependency', fields: [
          field('blocker', 'Blocker', 'reference', { reference: { targetEntityId: 'task', labelFieldId: 'taskName' } }),
          field('blocked', 'Blocked', 'reference', { reference: { targetEntityId: 'task', labelFieldId: 'taskName' } })] },
      ] },
      records: {
        task: nodes.map(node => record('task', node.id, { taskName: node.label, taskStatus: node.status ? statuses[node.status] : null })),
        dependency: edges.map(edge => record('dependency', edge.id, { blocker: edge.sourceId, blocked: edge.targetId },
          { blocker: names.get(edge.sourceId) ?? null, blocked: names.get(edge.targetId) ?? null })),
      },
    };
  };

  let view = null;
  const frameOf = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const frame = page.frames().find(candidate => candidate.url().startsWith(origin + '/'));
      if (frame !== undefined) { await frame.waitForSelector('#summary'); return frame; }
      await page.waitForTimeout(25);
    }
    throw new Error('The view never loaded from its own origin.');
  };
  const summary = () => view.locator('#summary').innerText();
  const until = async (predicate, arg, message) => {
    try { await view.waitForFunction(predicate, arg, { timeout: 5000, polling: 50 }); } catch {
      throw new Error(message + ' The view says: ' + JSON.stringify(await view.evaluate(() => document.getElementById('summary').textContent)));
    }
  };
  const requests = (from = 0) => page.evaluate(start => window.broker.requests.slice(start), from);
  const requestCount = () => page.evaluate(() => window.broker.requests.length);
  const openCount = () => page.evaluate(() => window.broker.opened().length);
  // What one action asked Nendo to open: wait for the first request, then long enough for a second.
  const opens = async action => {
    const before = await openCount();
    await action();
    await page.waitForFunction(count => window.broker.opened().length > count, before, { timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    return page.evaluate(count => window.broker.opened().slice(count), before);
  };
  const exactlyOne = (list, recordId, message) =>
    assert(list.length === 1 && list[0].entityId === 'task' && list[0].recordId === recordId && Object.keys(list[0]).sort().join() === 'entityId,recordId',
      message + ' ' + JSON.stringify(list));
  // The file changes and Nendo says so: the view shows what it then reads.
  const replace = async (next, expected) => {
    await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, next);
    await until(text => document.getElementById('summary').textContent === text, expected, `The graph never showed "${expected}" after the file changed.`);
  };

  const projection = { nodes: [
    { id: 'a', label: 'Design the record model', status: 'Doing' },
    { id: 'b', label: 'Build the graph', status: 'Next' },
    { id: 'c', label: '<img src=x onerror=alert(1)>', status: null },
  ], edges: [
    { id: 'e1', sourceId: 'a', targetId: 'b' }, { id: 'e2', sourceId: 'b', targetId: 'a' },
    { id: 'e3', sourceId: 'c', targetId: 'c' }, { id: 'e4', sourceId: 'a', targetId: 'b' },
  ] };
  await page.evaluate(value => window.broker.setFixture(value), fixture(projection));
  view = await frameOf();
  await until(() => document.querySelectorAll('.node').length > 0, undefined, 'The graph never drew its records.');

  // One hello and one connect, at the API version protocol.ts declares: the handshake is api.js's.
  const handshake = await page.evaluate(() => ({ connects: window.broker.connects, hellos: [...window.broker.hellos], apiVersion: window.broker.apiVersion }));
  assert(handshake.connects === 1 && JSON.stringify(handshake.hellos) === JSON.stringify([handshake.apiVersion]),
    'The view did not connect exactly once at the API version protocol.ts declares: ' + JSON.stringify(handshake));
  // The fixture, like the Workbench, connects only the frame it mounted.
  await page.evaluate(() => window.postMessage({ nendo: 'hello', apiVersion: 1 }, '*'));
  await page.waitForTimeout(100);
  const stray = await page.evaluate(() => ({ connects: window.broker.connects, refused: [...window.broker.refused] }));
  assert(stray.connects === 1 && stray.refused.includes('not the mounted frame'), 'The fixture connected a hello from outside its frame: ' + JSON.stringify(stray));

  assert(await view.locator('.node').count() === 3, 'The graph omitted a node.');
  // On open the nodes must sit inside the visible canvas, not off-screen: a graph fitted against a
  // stale (zero) size lands its nodes outside the viewport and looks empty (owner-reported at open on
  // a maximized window). Every node's centre must be within the canvas rectangle.
  const nodesInView = await view.evaluate(() => {
    const canvas = document.getElementById('canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.node')].map(node => {
      const r = node.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return cx >= canvas.x && cx <= canvas.x + canvas.width && cy >= canvas.y && cy <= canvas.y + canvas.height;
    });
  });
  assert(nodesInView.length === 3 && nodesInView.every(Boolean), 'A node opened outside the visible canvas: ' + JSON.stringify(nodesInView));
  assert(await view.locator('.edge').count() === 4, 'The graph omitted a cycle, self-link or parallel edge.');
  assert(await summary() === '3 records · 4 connections', 'Graph summary plural counts are wrong.');
  const parallelDistance = await view.evaluate(() => {
    const first = document.querySelector('[data-edge-id="e1"]'), second = document.querySelector('[data-edge-id="e4"]');
    return Math.abs(first.getPointAtLength(first.getTotalLength() / 2).y - second.getPointAtLength(second.getTotalLength() / 2).y);
  });
  assert(parallelDistance > 5, 'Parallel edges overlap on the same line.');
  assert(await view.locator('img').count() === 0, 'A record label became markup.');
  // A status is stored as its choice's option ID and shown by the choice's name.
  const shownStatus = await view.evaluate(() => Object.fromEntries([...document.querySelectorAll('.node')]
    .map(node => [node.dataset.id, node.querySelector('.status')?.textContent ?? null])));
  assert(shownStatus.a === 'Doing' && shownStatus.b === 'Next' && shownStatus.c === null, 'A status is not shown by its choice name: ' + JSON.stringify(shownStatus));
  // The gate cannot drive a real text selection in WebView2, so it measures the computed rule instead.
  const selectable = await view.evaluate(() => Object.fromEntries(['header', '#canvas', '#summary', 'footer', '#text-view']
    .map(s => [s, getComputedStyle(document.querySelector(s)).userSelect])));
  assert(['header', '#canvas', '#summary', 'footer'].every(s => selectable[s] === 'none'), 'Graph chrome is text-selectable: ' + JSON.stringify(selectable));
  assert(selectable['#text-view'] !== 'none', 'The text alternative must stay selectable: ' + JSON.stringify(selectable));

  // Selecting a record asks Nendo to open it: once, by its record type and ID.
  exactlyOne(await opens(() => view.locator('.node[data-id="a"]').click()), 'a', 'Selecting a record did not ask Nendo to open exactly that record, once:');
  assert(await view.locator('.node[data-id="a"]').getAttribute('aria-pressed') === 'true', 'The selected record is not marked as selected.');
  await view.locator('.node[data-id="a"]').focus();
  exactlyOne(await opens(async () => { await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); }), 'b',
    'Keyboard traversal opened the wrong record, or not once:');
  const before = await view.locator('#drawing').getAttribute('transform');
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert(await view.locator('#drawing').getAttribute('transform') !== before, 'Zoom control did not change the transform.');
  await view.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/graph-light.png' });
  // A refusal to open is said in the view, as text, and not thrown.
  await page.evaluate(() => window.broker.fail('ui.openRecord', { code: 'not-allowed', message: 'A record page has unsaved changes, so Nendo stays where it is until they are saved or closed.' }));
  await view.locator('.node[data-id="c"]').click();
  await until(() => document.getElementById('selection').textContent.includes('unsaved changes'), undefined, 'A refused open was not shown as text in the graph.');
  await view.getByRole('button', { name: 'Text view', exact: true }).click();
  assert(await view.locator('#text-view').isVisible(), 'Text alternative did not open.');
  assert(await view.locator('#records > li').count() === 3, 'Text alternative omitted a record.');
  assert((await view.locator('#records').innerText()).includes('Incoming:'), 'Text alternative omitted relationships.');
  exactlyOne(await opens(() => view.locator('#records button').nth(2).click()), 'c', 'The text alternative opened the wrong record, or not once:');

  // The Workbench's dark theme arrives as an event, and the graph's colours follow it.
  const lightColour = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => window.broker.pushTheme('dark'));
  await until(colour => getComputedStyle(document.body).backgroundColor !== colour, lightColour, 'A dark theme event did not change the graph\'s colours.');
  assert(await view.locator('html').getAttribute('data-theme') === 'dark', 'Theme update was ignored.');
  const darkColour = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/graph-dark-text.png' });
  await view.getByRole('button', { name: 'Graph view', exact: true }).click();

  // The file changes. The graph reads again only when Nendo says so, keeps the selected record
  // selected without opening it again, and shows what changed.
  exactlyOne(await opens(() => view.locator('.node[data-id="b"]').click()), 'b', 'Selecting a record did not open it once:');
  const opened = await openCount();
  let mark = await requestCount();
  await page.evaluate(value => window.broker.setFixture(value), fixture({ ...projection,
    nodes: projection.nodes.map(node => node.id === 'a' ? { ...node, label: 'Design the record model again' } : node) }));
  await page.waitForTimeout(400);
  const early = await requests(mark);
  assert(early.length === 0, 'The graph read the file before Nendo said it changed: ' + JSON.stringify(early.map(r => r.m)));
  const heard = await page.evaluate(() => { window.broker.pushChanges(); return window.broker.events.at(-1); });
  await until(() => document.querySelector('.node[data-id="a"] title')?.textContent === 'Design the record model again', undefined,
    'The graph did not read again and show the change after Nendo said the file changed.');
  const reread = await requests(mark);
  assert(reread.some(r => r.m === 'records.query'), 'The graph showed a change without reading the records again: ' + JSON.stringify(reread.map(r => r.m)));
  assert(reread[0].t - heard.t >= 150, `The graph read again ${reread[0].t - heard.t} ms after the change, not about a quarter of a second.`);
  assert(await view.locator('.node[data-id="b"]').getAttribute('aria-pressed') === 'true' &&
    (await view.locator('#selection').innerText()).startsWith('Build the graph selected'), 'The re-read lost the selection.');
  assert(await openCount() === opened, 'The re-read opened the selected record again.');
  mark = await requestCount();
  await page.evaluate(() => { for (let index = 0; index < 5; index += 1) window.broker.pushChanges(); });
  await page.waitForTimeout(900);
  const burst = (await requests(mark)).filter(r => r.m === 'records.query' && r.p.entityId === 'task' && (r.p.cursor ?? null) === null).length;
  assert(burst === 1, `A burst of five changes made ${burst} reads of the records, not one.`);

  await page.setViewportSize({ width: 480, height: 320 });
  assert(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Compact graph overflows horizontally.');
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/graph-dark-compact.png' });
  // 200% scaling halves the CSS pixels a 1024x768 window offers, so the same content must lay out in 512x384
  // without horizontal overflow, and every control must stay on screen and hittable rather than clipping away.
  await page.setViewportSize({ width: 512, height: 384 });
  assert(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Graph overflows horizontally at 200% scaling.');
  for (const name of ['Zoom out', 'Fit graph', 'Zoom in', 'Text view']) {
    const control = view.getByRole('button', { name, exact: true });
    assert(await control.isVisible(), 'Control hidden at 200% scaling: ' + name);
    const box = await control.boundingBox();
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 512 + 1 && box.y + box.height <= 384 + 1,
      'Control clipped outside the window at 200% scaling: ' + name);
  }
  const compactBefore = await view.locator('#drawing').getAttribute('transform');
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert(await view.locator('#drawing').getAttribute('transform') !== compactBefore, 'A control stopped responding at 200% scaling.');
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/graph-dark-200.png' });

  // A re-read that no longer has the selected record drops the selection; the counts are exact.
  await replace(fixture({ nodes: [{ id: 'new', label: 'Fresh generation' }], edges: [] }), '1 record · 0 connections');
  assert(await view.locator('.node').count() === 1, 'Projection replacement retained old nodes.');
  assert(await view.locator('.node.selected').count() === 0 && await view.locator('#selection').innerText() === 'No record selected',
    'A selection whose record is gone survived the re-read.');
  exactlyOne(await opens(() => view.locator('.node').click()), 'new', 'Selecting the new record opened the wrong one, or not once:');
  await replace(fixture({ nodes: [{ id: 'new', label: 'One' }], edges: [{ id: 'self', sourceId: 'new', targetId: 'new' }] }), '1 record · 1 connection');
  await replace(fixture({ nodes: [], edges: [] }), '0 records · 0 connections');
  assert(await view.locator('#empty').isVisible(), 'A graph with no records did not say so.');

  // A refused read is said in the view, as text, and the next change reads again.
  await page.evaluate(() => {
    window.broker.fail('records.query', { code: 'views-off', message: 'Custom views are off, so this view cannot read the file.' });
    window.broker.pushChanges();
  });
  await until(() => document.getElementById('summary').textContent.includes('Custom views are off'), undefined, 'A refused read was not shown as text in the graph.');
  await page.evaluate(() => window.broker.pushChanges());
  await until(() => document.getElementById('summary').textContent === '0 records · 0 connections', undefined, 'The graph did not recover when the file could be read again.');

  const methods = [...new Set((await requests()).map(r => r.m))].sort();
  assert(JSON.stringify(methods) === JSON.stringify(['records.query', 'schema.describe', 'ui.openRecord']),
    'The graph asked for something other than reads and opening a record: ' + JSON.stringify(methods));
  assert(errors.length === 0, 'Graph raised browser errors: ' + errors.join('; '));
  return JSON.stringify({ nodes: 3, edges: 4, handshake: true, openRecord: true, keyboard: true, zoom: true, textAlternative: true,
    themes: { light: lightColour, dark: darkColour }, rereadAfterChange: true, burstReads: burst, selectionKept: true,
    compact: '480x320', highDensity: '512x384', chromeNotSelectable: true, nodesInView: true, summaryCounts: true, refusedReadShown: true, pageErrors: errors });
}
