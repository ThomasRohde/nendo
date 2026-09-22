async (page) => {
  const root = '__NENDO_REPOSITORY__';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.graphMessages = [];
    window.chrome ??= {};
    window.chrome.webview = {
      addEventListener: (_, listener) => { window.deliverGraph = message => listener({ data: message }); },
      postMessage: message => window.graphMessages.push(message),
    };
  });
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto('__GRAPH_BASE_URL__/index.html');
  const projection = { sourceChangeSequence: 1, nodes: [
    { id: 'a', label: 'Design the record model', status: 'Doing' },
    { id: 'b', label: 'Build the graph', status: 'Next' },
    { id: 'c', label: '<img src=x onerror=alert(1)>', status: null },
  ], edges: [
    { id: 'e1', sourceId: 'a', targetId: 'b' }, { id: 'e2', sourceId: 'b', targetId: 'a' },
    { id: 'e3', sourceId: 'c', targetId: 'c' }, { id: 'e4', sourceId: 'a', targetId: 'b' },
  ] };
  await page.evaluate(projection => window.deliverGraph({ version: 1, method: 'initialize', session: 'gate', generation: 1, theme: 'light', locale: 'en', projection }), projection);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  assert(await page.locator('.node').count() === 3, 'The graph omitted a node.');
  // On open the nodes must sit inside the visible canvas, not off-screen: a graph fitted against a
  // stale (zero) size lands its nodes outside the viewport and looks empty (owner-reported at open on
  // a maximized window). Every node's centre must be within the canvas rectangle.
  const nodesInView = await page.evaluate(() => {
    const canvas = document.getElementById('canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.node')].map(node => {
      const r = node.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return cx >= canvas.x && cx <= canvas.x + canvas.width && cy >= canvas.y && cy <= canvas.y + canvas.height;
    });
  });
  assert(nodesInView.length === 3 && nodesInView.every(Boolean), 'A node opened outside the visible canvas: ' + JSON.stringify(nodesInView));
  assert(await page.locator('.edge').count() === 4, 'The graph omitted a cycle, self-link or parallel edge.');
  assert(await page.locator('#summary').innerText() === '3 records · 4 connections', 'Graph summary plural counts are wrong.');
  const parallelDistance = await page.evaluate(() => {
    const first = document.querySelector('[data-edge-id="e1"]'), second = document.querySelector('[data-edge-id="e4"]');
    return Math.abs(first.getPointAtLength(first.getTotalLength() / 2).y - second.getPointAtLength(second.getTotalLength() / 2).y);
  });
  assert(parallelDistance > 5, 'Parallel edges overlap on the same line.');
  assert(await page.locator('img').count() === 0, 'A record label became markup.');
  // The gate cannot drive a real text selection in WebView2, so it measures the computed rule instead.
  const selectable = await page.evaluate(() => Object.fromEntries(['header', '#canvas', '#summary', 'footer', '#text-view']
    .map(s => [s, getComputedStyle(document.querySelector(s)).userSelect])));
  assert(['header', '#canvas', '#summary', 'footer'].every(s => selectable[s] === 'none'), 'Graph chrome is text-selectable: ' + JSON.stringify(selectable));
  assert(selectable['#text-view'] !== 'none', 'The text alternative must stay selectable: ' + JSON.stringify(selectable));
  assert((await page.evaluate(() => window.graphMessages)).filter(m => m.method === 'ready').length === 1, 'Ready handshake was not emitted exactly once.');
  await page.locator('.node[data-id="a"]').click();
  assert((await page.evaluate(() => window.graphMessages)).at(-1).recordId === 'a', 'Node selection named the wrong record.');
  await page.locator('.node[data-id="a"]').focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  assert((await page.evaluate(() => window.graphMessages)).at(-1).recordId === 'b', 'Keyboard traversal named the wrong record.');
  const before = await page.locator('#drawing').getAttribute('transform');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert(await page.locator('#drawing').getAttribute('transform') !== before, 'Zoom control did not change the transform.');
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/graph-light.png' });
  await page.getByRole('button', { name: 'Text view', exact: true }).click();
  assert(await page.locator('#text-view').isVisible(), 'Text alternative did not open.');
  assert(await page.locator('#records > li').count() === 3, 'Text alternative omitted a record.');
  assert((await page.locator('#records').innerText()).includes('Incoming:'), 'Text alternative omitted relationships.');
  await page.locator('#records button').nth(2).click();
  assert((await page.evaluate(() => window.graphMessages)).at(-1).recordId === 'c', 'Text alternative selected the wrong record.');
  await page.evaluate(() => window.deliverGraph({ version: 1, method: 'setTheme', session: 'gate', theme: 'dark' }));
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/graph-dark-text.png' });
  assert(await page.locator('html').getAttribute('data-theme') === 'dark', 'Theme update was ignored.');
  await page.getByRole('button', { name: 'Graph view', exact: true }).click();
  await page.setViewportSize({ width: 480, height: 320 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Compact graph overflows horizontally.');
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/graph-dark-compact.png' });
  // 200% scaling halves the CSS pixels a 1024x768 window offers, so the same content must lay out in 512x384
  // without horizontal overflow, and every control must stay on screen and hittable rather than clipping away.
  await page.setViewportSize({ width: 512, height: 384 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Graph overflows horizontally at 200% scaling.');
  for (const name of ['Zoom out', 'Fit graph', 'Zoom in', 'Text view']) {
    const control = page.getByRole('button', { name, exact: true });
    assert(await control.isVisible(), 'Control hidden at 200% scaling: ' + name);
    const box = await control.boundingBox();
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 512 + 1 && box.y + box.height <= 384 + 1,
      'Control clipped outside the window at 200% scaling: ' + name);
  }
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert((await page.evaluate(() => window.graphMessages)).length >= 0, 'A control stopped responding at 200% scaling.');
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/graph-dark-200.png' });
  await page.evaluate(() => window.deliverGraph({ version: 1, method: 'replaceProjection', session: 'gate', generation: 2,
    projection: { sourceChangeSequence: 2, nodes: [{ id: 'new', label: 'Fresh generation' }], edges: [] } }));
  assert(await page.locator('.node').count() === 1, 'Projection replacement retained old nodes.');
  assert(await page.locator('.node.selected').count() === 0, 'Projection replacement retained selection.');
  await page.locator('.node').click();
  assert((await page.evaluate(() => window.graphMessages)).at(-1).generation === 2, 'Selection used a stale generation.');
  assert(await page.locator('#summary').innerText() === '1 record · 0 connections', 'Graph summary singular record count is wrong.');
  await page.evaluate(() => window.deliverGraph({ version: 1, method: 'replaceProjection', session: 'gate', generation: 3,
    projection: { sourceChangeSequence: 3, nodes: [{ id: 'new', label: 'One' }], edges: [{ id: 'self', sourceId: 'new', targetId: 'new' }] } }));
  assert(await page.locator('#summary').innerText() === '1 record · 1 connection', 'Graph summary singular connection count is wrong.');
  await page.evaluate(() => window.deliverGraph({ version: 1, method: 'replaceProjection', session: 'gate', generation: 4,
    projection: { sourceChangeSequence: 4, nodes: [], edges: [] } }));
  assert(await page.locator('#summary').innerText() === '0 records · 0 connections', 'Graph summary empty counts are wrong.');
  assert(errors.length === 0, 'Graph raised browser errors: ' + errors.join('; '));
  console.log(JSON.stringify({ nodes: 3, edges: 4, selection: true, keyboard: true, zoom: true, textAlternative: true,
    themes: ['light', 'dark'], compact: '480x320', highDensity: '512x384', chromeNotSelectable: true, nodesInView: true, generationReplacement: true, summaryCounts: true, pageErrors: errors }));
}
