async (page) => {
  const root = '__NENDO_REPOSITORY__';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.viewMessages = [];
    window.chrome ??= {};
    window.chrome.webview = {
      addEventListener: (_, listener) => { window.deliverView = message => listener({ data: message }); },
      postMessage: message => window.viewMessages.push(message),
    };
  });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.goto('__VIEW_BASE_URL__/index.html');
  const assert = (value, message) => { if (!value) throw new Error(message); };

  // A chain, an isolated item, a three-item cycle, one item standing behind that cycle, a
  // duplicate link and a label that looks like markup. Every claim the view makes is about
  // one of these shapes.
  const projection = { sourceChangeSequence: 1, nodes: [
    { id: 'a', label: 'Accept the amendment', status: 'Done' },
    { id: 'b', label: 'Build the isolated helper', status: 'Doing' },
    { id: 'c', label: 'Qualify the release', status: 'Ready' },
    { id: 'd', label: 'Write the authoring guide', status: null },
    { id: 'x', label: '<img src=x onerror=alert(1)>', status: 'Blocked' },
    { id: 'y', label: 'Second of the cycle', status: 'Blocked' },
    { id: 'z', label: 'Third of the cycle', status: 'Review' },
    { id: 'w', label: 'Behind the cycle', status: 'Inbox' },
  ], edges: [
    { id: 'e1', sourceId: 'a', targetId: 'b' }, { id: 'e2', sourceId: 'a', targetId: 'b' },
    { id: 'e3', sourceId: 'b', targetId: 'c' },
    { id: 'e4', sourceId: 'x', targetId: 'y' }, { id: 'e5', sourceId: 'y', targetId: 'z' },
    { id: 'e6', sourceId: 'z', targetId: 'x' }, { id: 'e7', sourceId: 'z', targetId: 'w' },
  ] };
  await page.evaluate(p => window.deliverView({ version: 1, method: 'initialize', session: 'gate', generation: 1, theme: 'light', locale: 'en', projection: p }), projection);

  assert((await page.evaluate(() => window.viewMessages)).filter(m => m.method === 'ready').length === 1, 'Ready handshake was not emitted exactly once.');
  assert(await page.locator('.node').count() === 8, 'The view omitted a work item.');
  assert(await page.locator('.edge').count() === 7, 'The view omitted a link, a duplicate or a cycle edge.');
  assert(await page.locator('img').count() === 0, 'A work item label became markup.');
  assert(await page.locator('#summary').innerText() === '8 work items · 7 links · 2 unblocked · 3 in a dependency cycle',
    'The summary is wrong: ' + await page.locator('#summary').innerText());

  // The layout is the claim: left to right is the order the work has to happen in. Every link
  // that is not part of a cycle must point at a column strictly further right.
  const columns = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.node')]
    .map(node => [node.dataset.id, Number(/translate\(([-0-9.]+)/.exec(node.getAttribute('transform'))[1])])));
  for (const [from, to] of [['a', 'b'], ['b', 'c'], ['z', 'w']])
    assert(columns[to] > columns[from], `${from} does not sit left of ${to}: ` + JSON.stringify(columns));

  // Tarjan, not "whatever the ordering pass could not settle": the three items in the cycle are
  // marked and the item merely standing behind it is not.
  const marked = await page.evaluate(() => [...document.querySelectorAll('.node')]
    .filter(node => [...node.querySelectorAll('text')].some(text => text.textContent === 'cycle')).map(node => node.dataset.id).sort());
  assert(JSON.stringify(marked) === JSON.stringify(['x', 'y', 'z']), 'The cycle is marked wrongly: ' + JSON.stringify(marked));
  const cycleEdges = await page.evaluate(() => [...document.querySelectorAll('.edge.cycle')].map(edge => edge.dataset.edgeId).sort());
  assert(JSON.stringify(cycleEdges) === JSON.stringify(['e4', 'e5', 'e6']), 'The cycle edges are drawn wrongly: ' + JSON.stringify(cycleEdges));

  // Nodes must open inside the visible canvas: a fit against a not-yet-sized canvas puts every
  // item off-screen and the view looks empty (owner-reported on the graph package, F-114).
  const inView = await page.evaluate(() => {
    const bounds = document.getElementById('canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.node')].map(node => {
      const r = node.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return cx >= bounds.x && cx <= bounds.x + bounds.width && cy >= bounds.y && cy <= bounds.y + bounds.height;
    });
  });
  assert(inView.length === 8 && inView.every(Boolean), 'A work item opened outside the visible canvas: ' + JSON.stringify(inView));

  await page.locator('.node[data-id="b"]').click();
  const selection = (await page.evaluate(() => window.viewMessages)).at(-1);
  assert(selection.method === 'selectRecord' && selection.recordId === 'b', 'Selecting an item named the wrong record.');
  // Two link records both saying a blocks b are two links and one blocker.
  assert(await page.locator('#selection').innerText() === 'Build the isolated helper · blocked by 1 · blocks 1',
    'The selection line is wrong: ' + await page.locator('#selection').innerText());

  // Focus answers "what is connected to this" by taking the rest out of the way.
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  const opacity = await page.evaluate(() => Object.fromEntries(['a', 'b', 'c', 'd', 'x']
    .map(id => [id, Number(getComputedStyle(document.querySelector(`.node[data-id="${id}"]`)).opacity)])));
  assert(opacity.a === 1 && opacity.b === 1 && opacity.c === 1, 'Focus faded something connected: ' + JSON.stringify(opacity));
  assert(opacity.d < .3 && opacity.x < .3, 'Focus left an unconnected item undimmed: ' + JSON.stringify(opacity));
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  assert(Number(await page.evaluate(() => getComputedStyle(document.querySelector('.node[data-id="d"]')).opacity)) === 1,
    'Leaving focus did not restore the view.');

  await page.locator('.node[data-id="a"]').focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  assert((await page.evaluate(() => window.viewMessages)).at(-1).recordId === 'b', 'Keyboard traversal named the wrong record.');

  const before = await page.locator('#drawing').getAttribute('transform');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert(await page.locator('#drawing').getAttribute('transform') !== before, 'Zoom did not change the transform.');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/work-dependencies-light.png' });

  // The text alternative carries the same relationships for a dense graph or a screen reader.
  await page.getByRole('button', { name: 'Text view', exact: true }).click();
  const rows = await page.evaluate(() => [...document.querySelectorAll('#records li')].map(row => row.innerText.replace(/\s+/g, ' ')));
  assert(rows.length === 8, 'The text alternative omitted a work item.');
  assert(rows.some(row => row.includes('Blocked by: Accept the amendment. Blocks: Qualify the release.')),
    'The text alternative does not say what blocks what: ' + JSON.stringify(rows.slice(0, 3)));
  assert(rows.some(row => row.includes('In a dependency cycle.')), 'The text alternative never mentions the cycle.');
  await page.getByRole('button', { name: 'Graph view', exact: true }).click();

  // The gate cannot drive a real text selection in WebView2, so it measures the computed rule.
  const selectable = await page.evaluate(() => Object.fromEntries(['header', '#canvas', '#summary', 'footer', '#text-view']
    .map(s => [s, getComputedStyle(document.querySelector(s)).userSelect])));
  assert(['header', '#canvas', '#summary', 'footer'].every(s => selectable[s] === 'none'), 'View chrome is text-selectable: ' + JSON.stringify(selectable));
  assert(selectable['#text-view'] !== 'none', 'The text alternative must stay selectable: ' + JSON.stringify(selectable));

  // A newer generation replaces the whole projection and clears the selection; the counts are
  // exact, singular included.
  await page.evaluate(() => window.deliverView({ version: 1, method: 'replaceProjection', session: 'gate', generation: 2,
    projection: { sourceChangeSequence: 2, nodes: [{ id: 'p', label: 'First', status: 'Doing' }, { id: 'q', label: 'Second', status: null }],
      edges: [{ id: 'e1', sourceId: 'p', targetId: 'q' }] } }));
  assert(await page.locator('#summary').innerText() === '2 work items · 1 link · 1 unblocked',
    'Replacement counts are wrong: ' + await page.locator('#summary').innerText());
  assert(await page.locator('#selection').innerText() === 'No work item selected', 'Replacement kept a stale selection.');
  await page.evaluate(() => window.deliverView({ version: 1, method: 'setTheme', session: 'gate', generation: 2, theme: 'dark' }));
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/work-dependencies-dark.png' });
  assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'The theme message was ignored.');

  // An empty file says so rather than drawing nothing.
  await page.evaluate(() => window.deliverView({ version: 1, method: 'replaceProjection', session: 'gate', generation: 3,
    projection: { sourceChangeSequence: 3, nodes: [], edges: [] } }));
  assert(await page.locator('#empty').isVisible(), 'An empty projection drew nothing and said nothing.');
  assert(await page.locator('#summary').innerText() === '0 work items · 0 links', 'The empty summary is wrong: ' + await page.locator('#summary').innerText());

  // The pane is half a window and can be small: 512x384 is a 1024x768 window at 200% scaling.
  await page.evaluate(p => window.deliverView({ version: 1, method: 'replaceProjection', session: 'gate', generation: 4, projection: { ...p, sourceChangeSequence: 4 } }), projection);
  await page.setViewportSize({ width: 512, height: 384 });
  await page.waitForTimeout(150);
  const compact = await page.evaluate(() => {
    const names = ['zoom-out', 'reset', 'zoom-in', 'focus-toggle', 'text-toggle'];
    const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    return { overflow, controls: names.map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    }) };
  });
  assert(!compact.overflow, 'The view overflows horizontally at 512x384.');
  assert(compact.controls.every(Boolean), 'A control left the window at 512x384: ' + JSON.stringify(compact.controls));

  assert(errors.length === 0, 'The view raised: ' + errors.join(' | '));
  return 'work dependencies ok';
}
