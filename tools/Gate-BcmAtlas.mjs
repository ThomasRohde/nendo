async (page) => {
  // Capability Atlas (extensions/bcm-atlas) against the shipped Northstar model, framed by the
  // fixture broker as the Workbench frames it. Review-BcmAtlas.ps1 builds the model from
  // tools/bcm-atlas/northstar.mjs and puts it in place of the placeholder below.
  const root = '__NENDO_REPOSITORY__';
  const model = '__BCM_FIXTURE__';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('__BROKER_URL__');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => window.broker.viewOrigin);

  const records = source => Object.fromEntries(Object.entries(source).map(([entityId, list]) =>
    [entityId, list.map(r => ({ entityId, recordId: r.recordId, version: 1, values: r.values, exact: {}, labels: {}, calculated: {} }))]));
  const fixture = (source, declared = true) => ({
    hierarchies: declared ? { 'bcm.capability': { parentFieldId: 'cap.parent', orderFieldId: 'cap.order' } } : {},
    context: { viewId: 'bcm.map', kind: 'extensionRecordsSurface', placement: 'screen', title: 'Capability map', entityId: 'bcm.capability', recordId: null,
      bindings: { labelFieldId: 'cap.name', statusFieldId: null, edgeEntityId: null, sourceFieldId: null, targetFieldId: null, fields: [], filters: [] } },
    schema: { entities: [] },
    records: records(source),
  });
  await page.evaluate(value => window.broker.setFixture(value), fixture(model));

  let view = null;
  for (let attempt = 0; attempt < 200 && view === null; attempt += 1) {
    view = page.frames().find(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')) ?? null;
    if (view === null) await page.waitForTimeout(25);
  }
  assert(view !== null, 'The view never loaded from its own origin.');
  const status = () => view.evaluate(() => document.getElementById('status').textContent);
  const until = async (predicate, arg, message) => {
    try { await view.waitForFunction(predicate, arg, { timeout: 8000, polling: 50 }); } catch { throw new Error(message + ' The view says: ' + JSON.stringify(await status())); }
  };
  const cards = () => view.evaluate(() => document.querySelectorAll('.cap').length);
  const transform = () => view.evaluate(() => document.getElementById('drawing').style.transform);
  const results = {};

  // The shipped model opens at two levels, and each level shows the cards it should.
  await until(() => /635 total$/.test(document.getElementById('status').textContent), null, 'The map never loaded the 635-capability model.');
  assert(await status() === '48 shown · 635 in scope · 635 total', 'The map did not open at two levels: ' + await status());
  const expected = { 1: 6, 2: 48, 3: 267, 4: 599, 5: 635, Infinity: 635 };
  for (const [level, count] of Object.entries(expected)) {
    await view.click(`[data-level="${level}"]`);
    assert(await cards() === count, `Levels ${level} shows ${await cards()} cards, not ${count}.`);
  }

  // Searching and recolouring restyle the cards; they never pack the map again. Packing the
  // whole model takes about half a second, so a new layout per keystroke stalls typing.
  await view.evaluate(() => {
    const engine = window.BcmLayout, pack = engine.layoutBcm;
    window.__bcmLayouts = 0;
    engine.layoutBcm = (...args) => { window.__bcmLayouts += 1; return pack(...args); };
  });
  const started = Date.now();
  await view.locator('#search').pressSequentially('payr');
  results.searchMs = Date.now() - started;
  await until(() => /^\d+ matches/.test(document.getElementById('status').textContent), null, 'Search never reported its matches.');
  assert(await view.evaluate(() => document.querySelectorAll('.cap.matched').length) >= 1, 'Search matched no card for "payr".');
  await view.selectOption('#colour', 'gap');
  const packs = await view.evaluate(() => window.__bcmLayouts);
  assert(packs === 0, `Typing four characters and changing the colour packed the whole map ${packs} times; only the tree changes the packing.`);
  await view.locator('#search').fill('');
  await view.selectOption('#colour', 'maturity');
  await view.click('[data-level="2"]');
  assert(await view.evaluate(() => window.__bcmLayouts) === 1, 'Changing the level did not pack the map once.');

  // A change made elsewhere refreshes the cards but leaves the camera where the person put it.
  await view.click('#zoom-in');
  await view.click('#zoom-in');
  const camera = await transform();
  const renamed = JSON.parse(JSON.stringify(model));
  renamed['bcm.capability'].find(r => r.recordId === 'bcm-cap-1').values['cap.name'] = 'Strategy & governance (renamed)';
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, fixture(renamed));
  await until(() => [...document.querySelectorAll('.cap-title')].some(n => n.textContent === 'Strategy & governance (renamed)'), null, 'The map never showed the renamed capability.');
  assert(await transform() === camera, `A change elsewhere moved the camera: ${camera} became ${await transform()}.`);

  // Ctrl-drag from a card pans by the pointer's movement and selects nothing.
  await view.click('#fit');
  const card = await view.locator('.cap.leaf').first().boundingBox();
  const before = await view.evaluate(() => { const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(document.getElementById('drawing').style.transform); return [Number(m[1]), Number(m[2])]; });
  await page.keyboard.down('Control');
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 60, card.y + card.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  const after = await view.evaluate(() => { const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(document.getElementById('drawing').style.transform); return [Number(m[1]), Number(m[2])]; });
  assert(Math.abs(after[0] - before[0] - 60) < 0.5 && Math.abs(after[1] - before[1] - 30) < 0.5, `Ctrl-drag from a card panned ${after[0] - before[0]} / ${after[1] - before[1]}, not 60 / 30.`);
  assert(await view.evaluate(() => document.querySelectorAll('.cap.selected').length) === 0, 'Ctrl-drag from a card selected it.');

  // The map is the tree the file declares (ADR-0019 stage 7): a file that declares none says so
  // and draws nothing, rather than building a tree the Engine does not keep.
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, fixture(model, false));
  await until(() => !document.getElementById('notice').hidden && /does not keep capabilities as a tree/.test(document.getElementById('notice').textContent),
    null, 'A file without the hierarchy did not say why there is no map.');
  results.undeclared = { cards: await cards(), empty: await view.evaluate(() => document.getElementById('empty').hidden) };
  assert(results.undeclared.cards === 0, `A file without the hierarchy still drew ${results.undeclared.cards} cards.`);
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, fixture(model));
  await until(() => /635 total$/.test(document.getElementById('status').textContent) && document.getElementById('notice').hidden, null, 'The map did not come back when the hierarchy did.');

  // Both themes take the Workbench's tokens, and a narrow pane does not scroll sideways.
  for (const [mode, canvas] of [['dark', 'rgb(15, 17, 21)'], ['light', 'rgb(243, 244, 246)']]) {
    await page.evaluate(value => window.broker.pushTheme(value), mode);
    await until(value => getComputedStyle(document.documentElement).backgroundColor === value, canvas, `The ${mode} theme never reached the view.`);
  }
  await page.setViewportSize({ width: 600, height: 700 });
  await page.waitForTimeout(200);
  assert(!(await view.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), 'The view overflows horizontally at 600px.');

  const methods = [...new Set((await page.evaluate(() => window.broker.requests)).map(r => r.m))].sort();
  assert(methods.every(m => ['records.get', 'records.query', 'records.tree', 'schema.describe', 'ui.openRecord'].includes(m)), 'The view asked for more than reads: ' + JSON.stringify(methods));
  assert(methods.includes('records.tree'), 'The map was not read as the declared tree: ' + JSON.stringify(methods));
  assert(errors.length === 0, 'The view raised: ' + errors.join(' | '));
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/bcm-atlas.png' });
  return 'bcm-atlas ok ' + JSON.stringify(results);
}
