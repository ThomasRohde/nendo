async (page) => {
  const root = '__NENDO_REPOSITORY__';
  const errors = [];
  // Errors in the view's own frame reach the page too, uncaught rejections included.
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  await page.setViewportSize({ width: 1024, height: 700 });
  // The broker page frames the package from another origin and answers it as the Workbench would.
  await page.goto('__BROKER_URL__');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => window.broker.viewOrigin);

  // Nendo Station's shape: components with a name, a State whose option IDs are not their names
  // and a System that is a reference to a system record, and feeds whose two references point at
  // components. The view binds a feed field first and the component's System second, so the band
  // must come from the first field of the component's own record type. The fixtures are written
  // as SYSTEM · name for reading and split here into the name and the system it references.
  const field = (fieldId, displayName, storageKind, extra = {}) => ({ fieldId, displayName, storageKind, required: false,
    presentation: null, calculated: false, expression: null, choices: [], reference: null, scale: null, ...extra });
  const record = (entityId, recordId, values, labels = {}) => ({ entityId, recordId, version: 1, values, exact: {}, labels, calculated: {} });
  const states = ['Online', 'Standby', 'Offline', 'Removed'];
  const systemId = name => 'system-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const reference = targetEntityId => ({ reference: { targetEntityId, labelFieldId: targetEntityId === 'system' ? 'systemName' : 'componentName' } });
  const fixture = ({ nodes, edges }) => {
    const parts = nodes.map(node => {
      const at = node.label.indexOf(' · ');
      return at === -1 ? { ...node, name: node.label, system: null } : { ...node, name: node.label.slice(at + 3), system: node.label.slice(0, at) };
    });
    const names = new Map(parts.map(part => [part.id, part.name]));
    return {
      context: { viewId: 'systemsLens', kind: 'extensionGraphSurface', placement: 'screen', title: 'Systems Lens', entityId: 'component', recordId: null,
        bindings: { labelFieldId: 'componentName', statusFieldId: 'componentState', edgeEntityId: 'feed', sourceFieldId: 'feedFrom', targetFieldId: 'feedTo',
          fields: [{ fieldId: 'feedMedium', entityId: 'feed' }, { fieldId: 'componentSystem', entityId: 'component' }], filters: [] } },
      schema: { entities: [
        { entityId: 'component', displayName: 'Component', fields: [field('componentName', 'Name', 'text'),
          field('componentState', 'State', 'text', { presentation: 'singleChoice',
            choices: states.map(name => ({ id: 'state-' + name.toLowerCase(), displayName: name, retired: false, tone: null })) }),
          field('componentSystem', 'System', 'reference', reference('system'))] },
        { entityId: 'system', displayName: 'System', fields: [field('systemName', 'Name', 'text')] },
        { entityId: 'feed', displayName: 'Feed', fields: [field('feedFrom', 'From', 'reference', reference('component')),
          field('feedTo', 'To', 'reference', reference('component')), field('feedMedium', 'Medium', 'text')] },
      ] },
      records: {
        component: parts.map(part => record('component', part.id, {
          componentName: part.name, componentState: part.status ? 'state-' + part.status.toLowerCase() : null,
          componentSystem: part.system === null ? null : systemId(part.system),
        }, part.system === null ? {} : { componentSystem: part.system })),
        system: [...new Set(parts.map(part => part.system).filter(system => system !== null))].map(system => record('system', systemId(system), { systemName: system })),
        feed: edges.map(edge => record('feed', edge.id, { feedFrom: edge.sourceId, feedTo: edge.targetId, feedMedium: 'Coolant' },
          { feedFrom: names.get(edge.sourceId) ?? null, feedTo: names.get(edge.targetId) ?? null })),
      },
    };
  };

  let view = null;
  const frameOf = async (previous = null) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const frame = page.frames().find(candidate => candidate !== previous && !candidate.isDetached() && candidate.url().startsWith(origin + '/'));
      if (frame !== undefined) { await frame.waitForSelector('#summary', { state: 'attached' }); return frame; }
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
    assert(list.length === 1 && list[0].entityId === 'component' && list[0].recordId === recordId && Object.keys(list[0]).sort().join() === 'entityId,recordId',
      message + ' ' + JSON.stringify(list));
  // The file changes and Nendo says so: the view shows what it then reads.
  const replace = async (next, expected) => {
    await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, next);
    await until(text => document.getElementById('summary').textContent === text, expected, `The schematic never showed "${expected}" after the file changed.`);
  };
  const verdicts = async () => view.evaluate(() => {
    const answer = { exposed: [], reduced: [], removed: [] };
    for (const node of document.querySelectorAll('.node')) {
      for (const kind of ['exposed', 'reduced', 'removed']) if (node.classList.contains(kind)) answer[kind].push(node.dataset.id);
    }
    for (const list of Object.values(answer)) list.sort();
    return answer;
  });

  // A reservoir feeding two pumps onto one manifold, a cold plate hanging off one of
  // those pumps alone, a three-component coolant circuit, an isolated sensor, a
  // component whose stored state is already Offline, a parallel feed and a label that
  // looks like markup. Every claim this view makes is about one of these shapes.
  const projection = { nodes: [
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
  ] };
  const fullSummary = '12 components · 12 feeds · 3 declared sources · 3 in a circuit';
  await page.evaluate(value => window.broker.setFixture(value), fixture(projection));
  view = await frameOf();
  await until(() => document.querySelectorAll('.node').length > 0, undefined, 'The schematic never drew its components.');

  // One hello and one connect, at the API version protocol.ts declares: the handshake is api.js's.
  const handshake = await page.evaluate(() => ({ connects: window.broker.connects, hellos: [...window.broker.hellos], apiVersion: window.broker.apiVersion }));
  assert(handshake.connects === 1 && JSON.stringify(handshake.hellos) === JSON.stringify([handshake.apiVersion]),
    'The view did not connect exactly once at the API version protocol.ts declares: ' + JSON.stringify(handshake));
  assert(await view.locator('.node').count() === 12, 'The schematic omitted a component.');
  assert(await view.locator('.edge').count() === 12, 'The schematic omitted a feed, a parallel feed or a circuit leg.');
  assert(await view.locator('img').count() === 0, 'A component label became markup.');
  assert(await summary() === fullSummary, 'The summary is wrong: ' + await summary());

  // Left to right is the direction of supply. Every feed that is not part of a circuit
  // must point at a column strictly further right.
  const columns = await view.evaluate(() => Object.fromEntries([...document.querySelectorAll('.node')]
    .map(node => [node.dataset.id, Number(/translate\(([-0-9.]+)/.exec(node.getAttribute('transform'))[1])])));
  for (const [from, to] of [['tank', 'pumpA'], ['pumpA', 'manifold'], ['manifold', 'rad'], ['pumpA', 'chiller'], ['chiller', 'plate']])
    assert(columns[to] > columns[from], `${from} does not sit left of ${to}: ` + JSON.stringify(columns));

  // A coolant circuit is a cycle. Tarjan names its members exactly; the manifold
  // standing in front of it is not in it.
  const inLoop = await view.evaluate(() => [...document.querySelectorAll('.node')]
    .filter(node => node.querySelector('.verdict')?.textContent === 'loop').map(node => node.dataset.id).sort());
  assert(JSON.stringify(inLoop) === JSON.stringify(['hx', 'rad2', 'valve']), 'The circuit is marked wrongly: ' + JSON.stringify(inLoop));
  const loopEdges = await view.evaluate(() => [...document.querySelectorAll('.edge.loop')].map(edge => edge.dataset.edgeId).sort());
  assert(JSON.stringify(loopEdges) === JSON.stringify(['e10', 'e11', 'e12']), 'The circuit legs are drawn wrongly: ' + JSON.stringify(loopEdges));

  // The system is the name the component's System reference points at, not the reference's
  // stored ID and not the feed field bound before it; the label is the component's name alone.
  const banded = await view.evaluate(() => {
    const node = document.querySelector('.node[data-id="tank"]');
    return { band: node.dataset.band, texts: [...node.querySelectorAll('text')].map(t => t.textContent) };
  });
  assert(banded.band === 'THERM', 'The system band was not read from the component\'s System reference: ' + JSON.stringify(banded));
  assert(banded.texts.includes('Coolant reservoir') && banded.texts.includes('Online'), 'The component name or state is not shown as it is named: ' + JSON.stringify(banded));
  assert(await view.evaluate(() => document.querySelector('.node[data-id="markup"]').dataset.band) === '',
    'A component with no system invented a band.');

  // A component already Offline is drawn as it is.
  assert(await view.evaluate(() => document.querySelector('.node[data-id="rad2"]').classList.contains('offline')),
    'A component stored Offline is not drawn as offline.');

  // Components must open inside the visible canvas: a fit against a not-yet-sized
  // canvas puts every one off-screen and the view looks empty.
  const inView = await view.evaluate(() => {
    const bounds = document.getElementById('canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.node')].map(node => {
      const r = node.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return cx >= bounds.x && cx <= bounds.x + bounds.width && cy >= bounds.y && cy <= bounds.y + bounds.height;
    });
  });
  assert(inView.length === 12 && inView.every(Boolean), 'A component opened outside the visible canvas: ' + JSON.stringify(inView));

  // Selecting a component asks Nendo to open it: once, by its record type and ID.
  exactlyOne(await opens(() => view.locator('.node[data-id="pumpA"]').click()), 'pumpA', 'Selecting a component did not ask Nendo to open exactly it, once:');
  // Two feed records both saying pump A supplies the manifold are two feeds and one
  // thing to say about the manifold.
  assert(await view.locator('#selection').innerText() === 'THERM · Coolant pump A · fed by 1 · feeds 2 (7 downstream in all)',
    'The selection line is wrong: ' + await view.locator('#selection').innerText());

  // ---------------------------------------------------------------------------
  // The claim this package must not overstate. Taking out pump A leaves the cold
  // plate chiller and the plate behind it with no declared path at all, while the
  // manifold and everything beyond it keep one through pump B. An implementation
  // that painted everything downstream would report seven exposed and none reduced,
  // and this is the assertion that refuses it.
  // ---------------------------------------------------------------------------
  await view.getByRole('button', { name: 'Take out', exact: true }).click();
  assert(await view.locator('#caveat').isVisible(), 'Take-out mode did not show what it does and does not claim.');
  const cut = await verdicts();
  assert(JSON.stringify(cut.exposed) === JSON.stringify(['chiller', 'plate']),
    'Taking out pump A named the wrong components as losing every path: ' + JSON.stringify(cut));
  assert(JSON.stringify(cut.reduced) === JSON.stringify(['hx', 'manifold', 'rad', 'rad2', 'valve']),
    'Taking out pump A named the wrong components as still fed: ' + JSON.stringify(cut));
  assert(JSON.stringify(cut.removed) === JSON.stringify(['pumpA']), 'The taken-out component is not marked as taken out.');
  assert(await summary() === 'Without THERM · Coolant pump A: 2 lose every declared path, 5 keep one',
    'The take-out summary is wrong: ' + await summary());

  // The text alternative names both sets, so the distinction survives a screen reader.
  await view.getByRole('button', { name: 'Text view', exact: true }).click();
  const rows = await view.evaluate(() => [...document.querySelectorAll('#records li')].map(row => row.innerText.replace(/\s+/g, ' ')));
  assert(rows.length === 12, 'The text alternative omitted a component.');
  assert(rows.some(row => row.includes('Online · Fed by: THERM · Coolant pump A, THERM · Coolant pump B.')),
    'The text alternative does not say what feeds what: ' + JSON.stringify(rows.slice(0, 3)));
  assert(rows.some(row => row.includes('it loses every declared feed path')), 'The text alternative never names an exposed component.');
  assert(rows.some(row => row.includes('it keeps a declared feed path')), 'The text alternative never names a component that stays fed.');
  assert(rows.some(row => row.includes('In a circuit.')), 'The text alternative never mentions the circuit.');
  await view.getByRole('button', { name: 'Schematic', exact: true }).click();

  // A single path does expose. Taking out the manifold leaves the radiator and the
  // whole circuit with nothing, which is the other half of the same claim.
  await view.getByRole('button', { name: 'Put back', exact: true }).click();
  exactlyOne(await opens(() => view.locator('.node[data-id="manifold"]').click()), 'manifold', 'Selecting the manifold did not open it once:');
  await view.getByRole('button', { name: 'Take out', exact: true }).click();
  const second = await verdicts();
  assert(JSON.stringify(second.exposed) === JSON.stringify(['hx', 'rad', 'rad2', 'valve']),
    'Taking out the manifold named the wrong components: ' + JSON.stringify(second));
  assert(second.reduced.length === 0, 'Taking out the manifold left something both fed and downstream: ' + JSON.stringify(second));

  // A what-if is page state. Escape puts it back, and nothing was ever written: the view has
  // asked for reads and for opening records, and for nothing else.
  await page.keyboard.press('Escape');
  assert((await verdicts()).removed.length === 0, 'Escape did not put the component back.');
  assert(!await view.locator('#caveat').isVisible(), 'Leaving take-out mode left its caveat on screen.');
  const asked = [...new Set((await requests()).map(r => r.m))].sort();
  assert(JSON.stringify(asked) === JSON.stringify(['records.query', 'schema.describe', 'ui.openRecord']),
    'The view asked for something other than reads and opening a record: ' + JSON.stringify(asked));

  // Focus answers "what is connected to this" by taking the rest out of the way.
  exactlyOne(await opens(() => view.locator('.node[data-id="chiller"]').click()), 'chiller', 'Selecting the chiller did not open it once:');
  await view.getByRole('button', { name: 'Focus', exact: true }).click();
  const opacity = await view.evaluate(() => Object.fromEntries(['tank', 'pumpA', 'chiller', 'plate', 'orphan', 'rad']
    .map(id => [id, Number(getComputedStyle(document.querySelector(`.node[data-id="${id}"]`)).opacity)])));
  assert(opacity.tank === 1 && opacity.pumpA === 1 && opacity.plate === 1, 'Focus faded something connected: ' + JSON.stringify(opacity));
  assert(opacity.orphan < .3 && opacity.rad < .3, 'Focus left an unconnected component undimmed: ' + JSON.stringify(opacity));
  await view.getByRole('button', { name: 'Focus', exact: true }).click();

  await view.locator('.node[data-id="tank"]').focus();
  exactlyOne(await opens(async () => { await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); }), 'pumpA',
    'Keyboard traversal opened the wrong component, or not once:');

  const before = await view.locator('#drawing').getAttribute('transform');
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert(await view.locator('#drawing').getAttribute('transform') !== before, 'Zoom did not change the transform.');
  await view.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/systems-lens-light.png' });

  // The gate cannot drive a real text selection in WebView2, so it measures the rule.
  const selectable = await view.evaluate(() => Object.fromEntries(['header', '#canvas', '#summary', 'footer', '#text-view']
    .map(s => [s, getComputedStyle(document.querySelector(s)).userSelect])));
  assert(['header', '#canvas', '#summary', 'footer'].every(s => selectable[s] === 'none'), 'View chrome is text-selectable: ' + JSON.stringify(selectable));
  assert(selectable['#text-view'] !== 'none', 'The text alternative must stay selectable: ' + JSON.stringify(selectable));
  // A refusal to open is said in the view, as text, and not thrown.
  await page.evaluate(() => window.broker.fail('ui.openRecord', { code: 'not-allowed', message: 'A record page has unsaved changes, so Nendo stays where it is until they are saved or closed.' }));
  await view.locator('.node[data-id="orphan"]').click();
  await until(() => document.getElementById('selection').textContent.includes('unsaved changes'), undefined, 'A refused open was not shown as text in the schematic.');

  // The file changes. The view reads again only when Nendo says so, ends a take-out (the graph
  // may have changed under the question), keeps the selected component selected without
  // opening it again, and shows what changed.
  exactlyOne(await opens(() => view.locator('.node[data-id="pumpA"]').click()), 'pumpA', 'Selecting pump A did not open it once:');
  await view.getByRole('button', { name: 'Take out', exact: true }).click();
  const opened = await openCount();
  let mark = await requestCount();
  await page.evaluate(value => window.broker.setFixture(value), fixture({ ...projection,
    nodes: projection.nodes.map(node => node.id === 'rad' ? { ...node, label: 'THERM · Radiator 1A' } : node) }));
  await page.waitForTimeout(400);
  const early = await requests(mark);
  assert(early.length === 0, 'The schematic read the file before Nendo said it changed: ' + JSON.stringify(early.map(r => r.m)));
  const heard = await page.evaluate(() => { window.broker.pushChanges(); return window.broker.events.at(-1); });
  await until(() => document.querySelector('.node[data-id="rad"] title')?.textContent === 'THERM · Radiator 1A — Online', undefined,
    'The schematic did not read again and show the change after Nendo said the file changed.');
  const reread = await requests(mark);
  assert(reread.some(r => r.m === 'records.query'), 'The schematic showed a change without reading again: ' + JSON.stringify(reread.map(r => r.m)));
  assert(reread[0].t - heard.t >= 150, `The schematic read again ${reread[0].t - heard.t} ms after the change, not about a quarter of a second.`);
  assert((await verdicts()).removed.length === 0 && !await view.locator('#caveat').isVisible() && await summary() === fullSummary,
    'A re-read kept a stale what-if: ' + await summary());
  const toggle = await view.evaluate(() => { const button = document.getElementById('takeout-toggle');
    return { disabled: button.disabled, pressed: button.getAttribute('aria-pressed'), text: button.textContent }; });
  assert(await view.locator('.node[data-id="pumpA"]').getAttribute('aria-pressed') === 'true' &&
    (await view.locator('#selection').innerText()).startsWith('THERM · Coolant pump A · fed by 1') &&
    JSON.stringify(toggle) === JSON.stringify({ disabled: false, pressed: 'false', text: 'Take out' }),
    'The re-read lost the selection, or left Take out in a stale state: ' + JSON.stringify(toggle));
  assert(await openCount() === opened, 'The re-read opened the selected component again.');
  mark = await requestCount();
  await page.evaluate(() => { for (let index = 0; index < 5; index += 1) window.broker.pushChanges(); });
  await page.waitForTimeout(900);
  const burst = (await requests(mark)).filter(r => r.m === 'records.query' && r.p.entityId === 'component' && (r.p.cursor ?? null) === null).length;
  assert(burst === 1, `A burst of five changes made ${burst} reads of the components, not one.`);

  // A re-read that no longer has the selected component drops the selection and must clear a
  // take-out.
  await view.getByRole('button', { name: 'Take out', exact: true }).click();
  await replace(fixture({ nodes: [{ id: 'p', label: 'Power Distribution · Array port', status: 'Online' }, { id: 'q', label: 'PWR · Charge regulator', status: null }],
    edges: [{ id: 'e1', sourceId: 'p', targetId: 'q' }] }), '2 components · 1 feed · 1 declared source');
  assert((await verdicts()).removed.length === 0, 'A new projection kept a stale what-if.');
  assert(!await view.locator('#caveat').isVisible(), 'A new projection kept the what-if caveat on screen.');
  assert(await view.locator('#selection').innerText() === 'No component selected', 'Replacement kept a stale selection.');
  // A referenced system arrives as the system's name, not a short code, and the node has to
  // show it whole and inside its own box; it once cut this to "Power Dist".
  const longBand = await view.evaluate(() => {
    const node = document.querySelector('.node[data-id="p"]');
    const band = node.querySelector('text.band'), box = node.querySelector('rect');
    const b = band.getBoundingClientRect(), r = box.getBoundingClientRect();
    return { text: band.textContent, inside: b.left >= r.left && b.right <= r.right + 0.5 && b.bottom <= r.bottom + 0.5 };
  });
  assert(longBand.text === 'Power Distribution' && longBand.inside, 'A long system name is cut or leaves its node: ' + JSON.stringify(longBand));
  assert(await view.evaluate(() => document.getElementById('takeout-toggle').disabled), 'Take out stayed available with nothing selected.');

  // The Workbench's dark theme arrives as an event, and the colours are the Workbench's own:
  // a token the Workbench sends is the colour the schematic draws with.
  const lightColour = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => window.broker.pushTheme('dark'));
  await until(colour => getComputedStyle(document.body).backgroundColor !== colour, lightColour, 'A dark theme event did not change the schematic\'s colours.');
  assert(await view.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'The theme event was ignored.');
  const darkColour = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/systems-lens-dark.png' });
  await page.evaluate(() => window.broker.pushTheme({ mode: 'dark', tokens: { ...window.broker.themes.dark, canvas: '#010203' } }));
  await until(() => getComputedStyle(document.body).backgroundColor === 'rgb(1, 2, 3)', undefined, 'The schematic does not draw with the Workbench\'s canvas token.');
  await page.evaluate(() => window.broker.pushTheme('dark'));

  // An empty file says so rather than drawing nothing.
  await replace(fixture({ nodes: [], edges: [] }), '0 components · 0 feeds');
  assert(await view.locator('#empty').isVisible(), 'An empty file drew nothing and said nothing.');

  // 500 components and 999 feeds must draw, read in pages: records.query answers 200 at a time.
  mark = await requestCount();
  const large = { nodes: [], edges: [] };
  for (let at = 0; at < 500; at += 1) large.nodes.push({ id: 'n' + at, label: 'PWR · Cell ' + at, status: at % 3 === 0 ? 'Online' : 'Standby' });
  for (let at = 0; at < 999; at += 1) large.edges.push({ id: 'g' + at, sourceId: 'n' + (at % 499), targetId: 'n' + ((at % 499) + 1) });
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, fixture(large));
  await until(() => document.querySelectorAll('.node').length === 500, undefined, 'The schematic did not draw 500 components.');
  assert(await view.locator('.edge').count() === 999, 'The schematic did not draw 999 feeds.');
  const continued = (await requests(mark)).filter(r => r.m === 'records.query' && (r.p.cursor ?? null) !== null).length;
  assert(continued >= 2, 'The large file was not read in pages: ' + continued + ' continuation pages.');

  // A refused read is said in the view, as text.
  await page.evaluate(() => {
    window.broker.fail('records.query', { code: 'views-off', message: 'Custom views are off, so this view cannot read the file.' });
    window.broker.pushChanges();
  });
  await until(() => document.getElementById('summary').textContent.includes('Custom views are off'), undefined, 'A refused read was not shown as text in the schematic.');

  // The pane is half a window and can be small: 512x384 is a 1024x768 window at 200%.
  await replace(fixture(projection), fullSummary);
  await page.setViewportSize({ width: 512, height: 384 });
  await page.waitForTimeout(150);
  const compact = await view.evaluate(() => {
    const names = ['zoom-out', 'reset', 'zoom-in', 'focus-toggle', 'takeout-toggle', 'text-toggle'];
    const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    return { overflow, controls: names.map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    }) };
  });
  assert(!compact.overflow, 'The view overflows horizontally at 512x384.');
  assert(compact.controls.every(Boolean), 'A control left the window at 512x384: ' + JSON.stringify(compact.controls));

  // ---- Nendo's own chrome (W-091). Everything above ran on a host that does not draw a view's
  // controls. On one that does, the view draws none of its own and no page title: it declares
  // them, Nendo sends a press back as a command, and a right-click on a component asks for
  // Nendo's menu. The fixture reads each declaration by the Workbench's own rules and refuses
  // what Nendo would refuse. The take-out claim is asked again from Nendo's toolbar and menu.
  await page.setViewportSize({ width: 1024, height: 700 });
  const plain = view;
  await page.evaluate(value => { window.broker.offerChrome(true); window.broker.setFixture(value); window.broker.remount(); }, fixture(projection));
  view = await frameOf(plain);
  await until(() => document.querySelectorAll('.node').length === 12, undefined, 'With Nendo drawing its controls, the schematic never drew its components.');
  const refusals = () => page.evaluate(() => window.broker.chromeRefusals);
  const lastToolbar = () => page.evaluate(() => window.broker.toolbars.at(-1) ?? null);
  const declaredWhere = async (test, message) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const last = await lastToolbar();
      if (last !== null && test(last)) return last;
      await page.waitForTimeout(25);
    }
    throw new Error(message + ' The last toolbar declared: ' + JSON.stringify(await lastToolbar()).slice(0, 600)
      + ' Refused by Nendo’s rules: ' + JSON.stringify(await refusals()));
  };
  const item = (toolbar, id) => toolbar.items.find(entry => entry.id === id);
  const shape = toolbar => toolbar.items.map(entry => entry.kind === 'group'
    ? `group:${entry.items.map(child => child.id + (child.keys ? '@' + child.keys : '')).join(',')}`
    : `${entry.kind}${entry.id ? ':' + entry.id : ''}${entry.keys ? '@' + entry.keys : ''}`);
  let declared = await declaredWhere(() => true, 'The view declared no toolbar.');
  assert((await refusals()).length === 0, 'Nendo would refuse what the view declared: ' + JSON.stringify(await refusals()));
  declared = await declaredWhere(last => last.items.find(entry => entry.kind === 'text')?.text === fullSummary, 'The view did not put its summary in Nendo\u2019s row.');
  assert(JSON.stringify(shape(declared)) === JSON.stringify(['toggle:focus', 'toggle:takeout', 'separator', 'text',
    'group:zoom-out@Ctrl+-,fit@Ctrl+0,zoom-in@Ctrl+Plus', 'separator', 'toggle:text', 'toggle:about']), 'The view declared another toolbar: ' + JSON.stringify(shape(declared)));
  assert(item(declared, 'takeout').disabled === true, 'Take out was offered with nothing selected.');
  const own = await view.evaluate(() => ({ native: document.documentElement.classList.contains('native-chrome'),
    tools: getComputedStyle(document.querySelector('.tools')).display, title: getComputedStyle(document.querySelector('h1')).display }));
  assert(JSON.stringify(own) === JSON.stringify({ native: true, tools: 'none', title: 'none' }),
    'The view still draws its own controls or title on a host that draws them: ' + JSON.stringify(own));

  // A command is a press of the control it stands for, and the toolbar follows.
  const command = (id, value = null, source = 'toolbar') => page.evaluate(([id, value, source]) => window.broker.command(id, value, source), [id, value, source]);
  exactlyOne(await opens(() => view.locator('.node[data-id="pumpA"]').click()), 'pumpA', 'Selecting pump A did not open it once:');
  await declaredWhere(last => item(last, 'takeout')?.disabled === false, 'Take out stayed unavailable with a component selected.');
  await command('takeout', true);
  await until(() => document.querySelector('.node[data-id="pumpA"]').classList.contains('removed'), undefined, 'Take out in Nendo’s toolbar took nothing out.');
  const fromToolbar = await verdicts();
  assert(JSON.stringify(fromToolbar.exposed) === JSON.stringify(['chiller', 'plate']) && JSON.stringify(fromToolbar.reduced) === JSON.stringify(['hx', 'manifold', 'rad', 'rad2', 'valve']),
    'Take out from Nendo’s toolbar did not ask the same question: ' + JSON.stringify(fromToolbar));
  assert(await view.locator('#caveat').isVisible(), 'Take out from Nendo’s toolbar did not show what it does and does not claim.');
  await declaredWhere(last => item(last, 'takeout')?.pressed === true && item(last, 'takeout')?.label === 'Put back', 'The toolbar did not follow the take-out.');
  await declaredWhere(last => last.items.find(entry => entry.kind === 'text')?.text === 'Without THERM · Coolant pump A: 2 lose every declared path, 5 keep one',
    'Nendo\u2019s row did not say what the take-out found.');
  await command('takeout', false);
  await until(() => document.querySelectorAll('.node.removed').length === 0, undefined, 'Put back in Nendo’s toolbar did not put the component back.');
  await command('focus', true);
  await until(() => document.getElementById('drawing').classList.contains('focused'), undefined, 'Focus in Nendo’s toolbar did not focus.');
  await declaredWhere(last => item(last, 'focus')?.pressed === true, 'The toolbar did not follow Focus.');
  await command('focus', false);
  await command('text', true);
  await until(() => !document.getElementById('text-view').hidden, undefined, 'The text command did not show the text view.');
  declared = await declaredWhere(last => item(last, 'text')?.pressed === true, 'The toolbar did not follow the text view.');
  assert(!declared.items.some(entry => entry.kind === 'group'), 'The text view still declares the zoom.');
  await command('text', false);
  await until(() => document.getElementById('text-view').hidden, undefined, 'The text command did not return to the schematic.');

  // The view's own lines (W-092): its summary is Nendo's row's text, its explanation waits
  // behind About, and the drawing starts at the top of the frame. A problem stays in the frame.
  const ownLines = () => view.evaluate(() => ({ header: getComputedStyle(document.querySelector('header')).display,
    hint: getComputedStyle(document.querySelector('.hint')).display, drawingTop: Math.round(document.querySelector('#canvas').getBoundingClientRect().top) }));
  const lines = await ownLines();
  assert(lines.header === 'none' && lines.hint === 'none' && lines.drawingTop <= 12,
    'The schematic still spends lines of its frame on its summary or its explanation: ' + JSON.stringify(lines));
  await command('about', true);
  await until(() => getComputedStyle(document.querySelector('.hint')).display === 'block' && getComputedStyle(document.querySelector('.hint')).position === 'fixed',
    undefined, 'About in Nendo\u2019s row did not show the explanation.');
  await declaredWhere(last => last.items.find(item => item.id === 'about')?.pressed === true, 'The toolbar did not follow About.');
  await view.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => getComputedStyle(document.querySelector('.hint')).display === 'none', undefined, 'Escape did not put the explanation away.');
  await page.evaluate(() => {
    window.broker.fail('records.query', { code: 'views-off', message: 'Custom views are off, so this view cannot read the file.' });
    window.broker.pushChanges();
  });
  await until(() => document.getElementById('summary').classList.contains('problem') && getComputedStyle(document.querySelector('header')).display !== 'none',
    undefined, 'A problem reading the file was not said in the frame, whole.');
  await declaredWhere(last => !last.items.some(item => item.kind === 'text'), 'A problem was put in Nendo\u2019s row, where it would be cut short.');
  await page.evaluate(() => window.broker.pushChanges());
  await until(() => document.querySelectorAll('.node').length === 12, undefined, 'The schematic did not draw again after the file could be read.');
  await until(() => !document.getElementById('summary').classList.contains('problem') && getComputedStyle(document.querySelector('header')).display === 'none',
    undefined, 'The frame kept the problem after the file could be read again.');
  const unzoomed = await view.locator('#drawing').getAttribute('transform');
  await command('zoom-in');
  await until(before => document.getElementById('drawing').getAttribute('transform') !== before, unzoomed, 'Zoom in from Nendo’s toolbar did not zoom.');
  await command('fit');

  // A right-click on a component asks Nendo for its menu, and each pick does what it says.
  const menuAt = async (id, pick) => {
    const before = (await page.evaluate(() => window.broker.menus)).length;
    await page.evaluate(value => window.broker.pickNext(value), pick);
    const browserMenu = await view.evaluate(id => {
      const node = document.querySelector(`.node[data-id="${id}"]`), box = node.getBoundingClientRect();
      return node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.top + 12, button: 2 }));
    }, id);
    assert(browserMenu === false, 'The browser’s own menu was left to open over Nendo’s.');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const all = await page.evaluate(() => window.broker.menus);
      if (all.length > before) return all.at(-1).items.map(entry => [entry.id ?? entry.kind, entry.label ?? null]);
      await page.waitForTimeout(25);
    }
    throw new Error('A right-click on a component asked Nendo for no menu. Refused by Nendo’s rules: ' + JSON.stringify(await refusals()));
  };
  let menu = await menuAt('manifold', { id: 'take-out', value: null });
  assert(JSON.stringify(menu) === JSON.stringify([['open', 'Open component'], ['separator', null], ['take-out', 'Take it out']]),
    'The component menu is not Open and Take it out: ' + JSON.stringify(menu));
  await until(() => document.querySelector('.node[data-id="manifold"]').classList.contains('removed'), undefined, 'Take it out from the menu took nothing out.');
  const fromMenu = await verdicts();
  assert(JSON.stringify(fromMenu.exposed) === JSON.stringify(['hx', 'rad', 'rad2', 'valve']) && fromMenu.reduced.length === 0,
    'Take it out from the menu did not ask the question about the manifold: ' + JSON.stringify(fromMenu));
  menu = await menuAt('manifold', { id: 'put-back', value: null });
  assert(JSON.stringify(menu.at(-1)) === JSON.stringify(['put-back', 'Put it back']), 'The taken-out component’s menu does not offer to put it back: ' + JSON.stringify(menu));
  await until(() => document.querySelectorAll('.node.removed').length === 0, undefined, 'Put it back from the menu did not put the component back.');
  let pickedOpen = null;
  exactlyOne(await opens(async () => { pickedOpen = await menuAt('chiller', { id: 'open', value: null }); }), 'chiller', 'Open picked from the menu did not open the component, once:');
  assert(pickedOpen[0][0] === 'open', 'The component menu does not start with Open: ' + JSON.stringify(pickedOpen));
  assert((await refusals()).length === 0, 'Nendo would refuse what the view declared or asked for: ' + JSON.stringify(await refusals()));
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/systems-lens-native-chrome.png' });
  await page.evaluate(() => window.broker.offerChrome(false));

  assert(errors.length === 0, 'The view raised: ' + errors.join(' | '));
  return 'systems lens ok ' + JSON.stringify({ themes: { light: lightColour, dark: darkColour }, burstReads: burst, continuationPages: continued });
}
