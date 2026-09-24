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

  // A reservoir feeding two pumps onto one manifold, a cold plate hanging off one of
  // those pumps alone, a three-component coolant circuit, an isolated sensor, a
  // component whose stored state is already Offline, a parallel feed and a label that
  // looks like markup. Every claim this view makes is about one of these shapes.
  // Protocol 2 (ADR-0013, 2026-09-24): the system is a disclosed field, not part of the
  // label. The fixtures are written as SYSTEM · name for reading, and split here into the
  // shape the host sends: the name as the label, the system as the first node field.
  const asProtocol2 = source => ({
    ...source, hiddenEdges: 0, fields: [{ id: 'componentSystem', name: 'System', type: 'reference', of: 'node' }],
    nodes: source.nodes.map(node => {
      const at = node.label.indexOf(' · ');
      return at === -1 ? { ...node, values: { componentSystem: null } }
        : { ...node, label: node.label.slice(at + 3), values: { componentSystem: node.label.slice(0, at) } };
    }),
    edges: source.edges.map(edge => ({ ...edge, values: {} })),
  });
  await page.evaluate(source => { window.asProtocol2 = new Function('return ' + source)(); }, asProtocol2.toString());
  const projection = asProtocol2({ sourceChangeSequence: 1, nodes: [
    { id: 'tank', label: 'THERM · Coolant reservoir', status: 'Online' },
    { id: 'pumpA', label: 'THERM · Coolant pump A', status: 'Online' },
    { id: 'pumpB', label: 'THERM · Coolant pump B', status: 'Standby' },
    { id: 'manifold', label: 'THERM · Coolant manifold', status: 'Online' },
    { id: 'rad', label: 'THERM · Radiator 1', status: 'Online' },
    { id: 'chiller', label: 'THERM · Cold plate chiller', status: 'Online' },
    { id: 'plate', label: 'THERM · Lab cold plate', status: 'Online' },
    { id: 'valve', label: 'THERM · Loop isolation valve', status: 'Online' },
    { id: 'hx', label: 'THERM · Lab heat exchanger', status: 'Online' },
    { id: 'rad2', label: 'THERM · Radiator 2', status: 'Offline' },
    { id: 'orphan', label: 'COM · Link quality sensor', status: 'Online' },
    { id: 'markup', label: '<img src=x onerror=alert(1)>', status: null },
  ], edges: [
    { id: 'e1', sourceId: 'tank', targetId: 'pumpA' },
    { id: 'e2', sourceId: 'tank', targetId: 'pumpB' },
    { id: 'e3', sourceId: 'pumpA', targetId: 'manifold' },
    { id: 'e4', sourceId: 'pumpB', targetId: 'manifold' },
    { id: 'e5', sourceId: 'pumpA', targetId: 'manifold' },
    { id: 'e6', sourceId: 'manifold', targetId: 'rad' },
    { id: 'e7', sourceId: 'pumpA', targetId: 'chiller' },
    { id: 'e8', sourceId: 'chiller', targetId: 'plate' },
    { id: 'e9', sourceId: 'manifold', targetId: 'valve' },
    { id: 'e10', sourceId: 'valve', targetId: 'rad2' },
    { id: 'e11', sourceId: 'rad2', targetId: 'hx' },
    { id: 'e12', sourceId: 'hx', targetId: 'valve' },
  ] });
  await page.evaluate(p => window.deliverView({ version: 2, method: 'initialize', session: 'gate', generation: 1, theme: 'light', locale: 'en', projection: p }), projection);

  assert((await page.evaluate(() => window.viewMessages)).filter(m => m.method === 'ready').length === 1, 'Ready handshake was not emitted exactly once.');
  assert(await page.locator('.node').count() === 12, 'The schematic omitted a component.');
  assert(await page.locator('.edge').count() === 12, 'The schematic omitted a feed, a parallel feed or a circuit leg.');
  assert(await page.locator('img').count() === 0, 'A component label became markup.');
  assert(await page.locator('#summary').innerText() === '12 components · 12 feeds · 3 declared sources · 3 in a circuit',
    'The summary is wrong: ' + await page.locator('#summary').innerText());

  // Left to right is the direction of supply. Every feed that is not part of a circuit
  // must point at a column strictly further right.
  const columns = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.node')]
    .map(node => [node.dataset.id, Number(/translate\(([-0-9.]+)/.exec(node.getAttribute('transform'))[1])])));
  for (const [from, to] of [['tank', 'pumpA'], ['pumpA', 'manifold'], ['manifold', 'rad'], ['pumpA', 'chiller'], ['chiller', 'plate']])
    assert(columns[to] > columns[from], `${from} does not sit left of ${to}: ` + JSON.stringify(columns));

  // A coolant circuit is a cycle. Tarjan names its members exactly; the manifold
  // standing in front of it is not in it.
  const inLoop = await page.evaluate(() => [...document.querySelectorAll('.node')]
    .filter(node => node.querySelector('.verdict')?.textContent === 'loop').map(node => node.dataset.id).sort());
  assert(JSON.stringify(inLoop) === JSON.stringify(['hx', 'rad2', 'valve']), 'The circuit is marked wrongly: ' + JSON.stringify(inLoop));
  const loopEdges = await page.evaluate(() => [...document.querySelectorAll('.edge.loop')].map(edge => edge.dataset.edgeId).sort());
  assert(JSON.stringify(loopEdges) === JSON.stringify(['e10', 'e11', 'e12']), 'The circuit legs are drawn wrongly: ' + JSON.stringify(loopEdges));

  // The system is the disclosed field's value; the label is the name alone.
  const banded = await page.evaluate(() => {
    const node = document.querySelector('.node[data-id="tank"]');
    return { band: node.dataset.band, texts: [...node.querySelectorAll('text')].map(t => t.textContent) };
  });
  assert(banded.band === 'THERM', 'The system band was not read from the disclosed field: ' + JSON.stringify(banded));
  assert(banded.texts.includes('Coolant reservoir'), 'The component name still carries its band: ' + JSON.stringify(banded));
  assert(await page.evaluate(() => document.querySelector('.node[data-id="markup"]').dataset.band) === '',
    'A component with no system invented a band.');

  // A component already Offline is drawn as it is.
  assert(await page.evaluate(() => document.querySelector('.node[data-id="rad2"]').classList.contains('offline')),
    'A component stored Offline is not drawn as offline.');

  // Components must open inside the visible canvas: a fit against a not-yet-sized
  // canvas puts every one off-screen and the view looks empty.
  const inView = await page.evaluate(() => {
    const bounds = document.getElementById('canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.node')].map(node => {
      const r = node.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return cx >= bounds.x && cx <= bounds.x + bounds.width && cy >= bounds.y && cy <= bounds.y + bounds.height;
    });
  });
  assert(inView.length === 12 && inView.every(Boolean), 'A component opened outside the visible canvas: ' + JSON.stringify(inView));

  await page.locator('.node[data-id="pumpA"]').click();
  const selection = (await page.evaluate(() => window.viewMessages)).at(-1);
  assert(selection.method === 'selectRecord' && selection.recordId === 'pumpA', 'Selecting a component named the wrong record.');
  // Two feed records both saying pump A supplies the manifold are two feeds and one
  // thing to say about the manifold.
  assert(await page.locator('#selection').innerText() === 'THERM · Coolant pump A · fed by 1 · feeds 2 (7 downstream in all)',
    'The selection line is wrong: ' + await page.locator('#selection').innerText());

  // ---------------------------------------------------------------------------
  // The claim this package must not overstate. Taking out pump A leaves the cold
  // plate chiller and the plate behind it with no declared path at all, while the
  // manifold and everything beyond it keep one through pump B. An implementation
  // that painted everything downstream would report seven exposed and none reduced,
  // and this is the assertion that refuses it.
  // ---------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Take out', exact: true }).click();
  assert(await page.locator('#caveat').isVisible(), 'Take-out mode did not show what it does and does not claim.');
  const verdicts = async () => page.evaluate(() => {
    const answer = { exposed: [], reduced: [], removed: [] };
    for (const node of document.querySelectorAll('.node')) {
      for (const kind of ['exposed', 'reduced', 'removed']) if (node.classList.contains(kind)) answer[kind].push(node.dataset.id);
    }
    for (const list of Object.values(answer)) list.sort();
    return answer;
  });
  const cut = await verdicts();
  assert(JSON.stringify(cut.exposed) === JSON.stringify(['chiller', 'plate']),
    'Taking out pump A named the wrong components as losing every path: ' + JSON.stringify(cut));
  assert(JSON.stringify(cut.reduced) === JSON.stringify(['hx', 'manifold', 'rad', 'rad2', 'valve']),
    'Taking out pump A named the wrong components as still fed: ' + JSON.stringify(cut));
  assert(JSON.stringify(cut.removed) === JSON.stringify(['pumpA']), 'The taken-out component is not marked as taken out.');
  assert(await page.locator('#summary').innerText() === 'Without THERM · Coolant pump A: 2 lose every declared path, 5 keep one',
    'The take-out summary is wrong: ' + await page.locator('#summary').innerText());

  // The text alternative names both sets, so the distinction survives a screen reader.
  await page.getByRole('button', { name: 'Text view', exact: true }).click();
  const rows = await page.evaluate(() => [...document.querySelectorAll('#records li')].map(row => row.innerText.replace(/\s+/g, ' ')));
  assert(rows.length === 12, 'The text alternative omitted a component.');
  assert(rows.some(row => row.includes('Fed by: THERM · Coolant pump A, THERM · Coolant pump B.')),
    'The text alternative does not say what feeds what: ' + JSON.stringify(rows.slice(0, 3)));
  assert(rows.some(row => row.includes('it loses every declared feed path')), 'The text alternative never names an exposed component.');
  assert(rows.some(row => row.includes('it keeps a declared feed path')), 'The text alternative never names a component that stays fed.');
  assert(rows.some(row => row.includes('In a circuit.')), 'The text alternative never mentions the circuit.');
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();

  // A single path does expose. Taking out the manifold leaves the radiator and the
  // whole circuit with nothing, which is the other half of the same claim.
  await page.getByRole('button', { name: 'Put back', exact: true }).click();
  await page.locator('.node[data-id="manifold"]').click();
  await page.getByRole('button', { name: 'Take out', exact: true }).click();
  const second = await verdicts();
  assert(JSON.stringify(second.exposed) === JSON.stringify(['hx', 'rad', 'rad2', 'valve']),
    'Taking out the manifold named the wrong components: ' + JSON.stringify(second));
  assert(second.reduced.length === 0, 'Taking out the manifold left something both fed and downstream: ' + JSON.stringify(second));

  // A what-if is session state. Escape puts it back and nothing was ever written.
  await page.keyboard.press('Escape');
  assert((await verdicts()).removed.length === 0, 'Escape did not put the component back.');
  assert(!await page.locator('#caveat').isVisible(), 'Leaving take-out mode left its caveat on screen.');
  const methods = [...new Set((await page.evaluate(() => window.viewMessages)).map(m => m.method))].sort();
  assert(JSON.stringify(methods) === JSON.stringify(['ready', 'selectRecord']),
    'The view sent something other than a handshake and a selection: ' + JSON.stringify(methods));

  // Focus answers "what is connected to this" by taking the rest out of the way.
  await page.locator('.node[data-id="chiller"]').click();
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  const opacity = await page.evaluate(() => Object.fromEntries(['tank', 'pumpA', 'chiller', 'plate', 'orphan', 'rad']
    .map(id => [id, Number(getComputedStyle(document.querySelector(`.node[data-id="${id}"]`)).opacity)])));
  assert(opacity.tank === 1 && opacity.pumpA === 1 && opacity.plate === 1, 'Focus faded something connected: ' + JSON.stringify(opacity));
  assert(opacity.orphan < .3 && opacity.rad < .3, 'Focus left an unconnected component undimmed: ' + JSON.stringify(opacity));
  await page.getByRole('button', { name: 'Focus', exact: true }).click();

  await page.locator('.node[data-id="tank"]').focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  assert((await page.evaluate(() => window.viewMessages)).at(-1).method === 'selectRecord', 'Keyboard traversal did not select.');

  const before = await page.locator('#drawing').getAttribute('transform');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert(await page.locator('#drawing').getAttribute('transform') !== before, 'Zoom did not change the transform.');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/systems-lens-light.png' });

  // The gate cannot drive a real text selection in WebView2, so it measures the rule.
  const selectable = await page.evaluate(() => Object.fromEntries(['header', '#canvas', '#summary', 'footer', '#text-view']
    .map(s => [s, getComputedStyle(document.querySelector(s)).userSelect])));
  assert(['header', '#canvas', '#summary', 'footer'].every(s => selectable[s] === 'none'), 'View chrome is text-selectable: ' + JSON.stringify(selectable));
  assert(selectable['#text-view'] !== 'none', 'The text alternative must stay selectable: ' + JSON.stringify(selectable));

  // A newer generation replaces the whole projection, clears the selection, and must
  // clear a take-out: the graph may have changed under the question.
  await page.locator('.node[data-id="pumpA"]').click();
  await page.getByRole('button', { name: 'Take out', exact: true }).click();
  await page.evaluate(() => window.deliverView({ version: 2, method: 'replaceProjection', session: 'gate', generation: 2,
    projection: window.asProtocol2({ sourceChangeSequence: 2, nodes: [{ id: 'p', label: 'Power Distribution · Array port', status: 'Online' }, { id: 'q', label: 'PWR · Charge regulator', status: null }],
      edges: [{ id: 'e1', sourceId: 'p', targetId: 'q' }] }) }));
  assert((await verdicts()).removed.length === 0, 'A new projection kept a stale what-if.');
  assert(!await page.locator('#caveat').isVisible(), 'A new projection kept the what-if caveat on screen.');
  assert(await page.locator('#summary').innerText() === '2 components · 1 feed · 1 declared source',
    'Replacement counts are wrong: ' + await page.locator('#summary').innerText());
  assert(await page.locator('#selection').innerText() === 'No component selected', 'Replacement kept a stale selection.');
  // A disclosed reference arrives as the system's name, not a short code, and the node
  // has to show it whole and inside its own box; it once cut this to "Power Dist".
  const longBand = await page.evaluate(() => {
    const node = document.querySelector('.node[data-id="p"]');
    const band = node.querySelector('text.band'), box = node.querySelector('rect');
    const b = band.getBoundingClientRect(), r = box.getBoundingClientRect();
    return { text: band.textContent, inside: b.left >= r.left && b.right <= r.right + 0.5 && b.bottom <= r.bottom + 0.5 };
  });
  assert(longBand.text === 'Power Distribution' && longBand.inside, 'A long system name is cut or leaves its node: ' + JSON.stringify(longBand));
  assert(await page.evaluate(() => document.getElementById('takeout-toggle').disabled), 'Take out stayed available with nothing selected.');

  await page.evaluate(() => window.deliverView({ version: 2, method: 'setTheme', session: 'gate', generation: 2, theme: 'dark' }));
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/systems-lens-dark.png' });
  assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'The theme message was ignored.');

  // An empty file says so rather than drawing nothing.
  await page.evaluate(() => window.deliverView({ version: 2, method: 'replaceProjection', session: 'gate', generation: 3,
    projection: window.asProtocol2({ sourceChangeSequence: 3, nodes: [], edges: [] }) }));
  assert(await page.locator('#empty').isVisible(), 'An empty projection drew nothing and said nothing.');
  assert(await page.locator('#summary').innerText() === '0 components · 0 feeds', 'The empty summary is wrong: ' + await page.locator('#summary').innerText());

  // The bound the host refuses above: 500 components and 1,000 feeds must draw.
  await page.evaluate(() => {
    const nodes = [], edges = [];
    for (let at = 0; at < 500; at += 1) nodes.push({ id: 'n' + at, label: 'PWR · Cell ' + at, status: at % 3 === 0 ? 'Online' : 'Standby' });
    for (let at = 0; at < 999; at += 1) edges.push({ id: 'g' + at, sourceId: 'n' + (at % 499), targetId: 'n' + ((at % 499) + 1) });
    window.deliverView({ version: 2, method: 'replaceProjection', session: 'gate', generation: 4,
      projection: window.asProtocol2({ sourceChangeSequence: 4, nodes, edges }) });
  });
  assert(await page.locator('.node').count() === 500, 'The schematic did not draw the full projection bound.');

  // The pane is half a window and can be small: 512x384 is a 1024x768 window at 200%.
  await page.evaluate(p => window.deliverView({ version: 2, method: 'replaceProjection', session: 'gate', generation: 5, projection: { ...p, sourceChangeSequence: 5 } }), projection);
  await page.setViewportSize({ width: 512, height: 384 });
  await page.waitForTimeout(150);
  const compact = await page.evaluate(() => {
    const names = ['zoom-out', 'reset', 'zoom-in', 'focus-toggle', 'takeout-toggle', 'text-toggle'];
    const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    return { overflow, controls: names.map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    }) };
  });
  assert(!compact.overflow, 'The view overflows horizontally at 512x384.');
  assert(compact.controls.every(Boolean), 'A control left the window at 512x384: ' + JSON.stringify(compact.controls));

  assert(errors.length === 0, 'The view raised: ' + errors.join(' | '));
  return 'systems lens ok';
}
