async (page) => {
  // Capability Atlas (extensions/bcm-atlas) framed by the fixture broker as the Workbench frames
  // it, over two files (tools/bcm-atlas/fixtures.mjs, which Review-BcmAtlas.ps1 puts in place of
  // the placeholder below): BCM.nendo's Northstar model with its real schema, bindings and
  // configuration, and a second file with other record types, other field IDs and only some of
  // the Atlas's parts (W-077).
  const root = '__NENDO_REPOSITORY__';
  const fixtures = '__ATLAS_FIXTURES__';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('__BROKER_URL__');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  const clone = value => JSON.parse(JSON.stringify(value));
  const bcm = fixtures.bcm;
  // A file that does not declare the tree: no hierarchy in the schema, and the tree read refused.
  const undeclared = file => ({ ...file, hierarchies: {}, schema: { ...file.schema, entities: file.schema.entities.map(entity => ({ ...entity, hierarchy: null })) } });
  await page.evaluate(value => window.broker.setFixture(value), bcm);

  let view = null;
  const attach = async () => {
    view = null;
    for (let attempt = 0; attempt < 200 && view === null; attempt += 1) {
      view = page.frames().find(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')) ?? null;
      if (view === null) await page.waitForTimeout(25);
    }
    assert(view !== null, 'The view never loaded from its own origin.');
  };
  await attach();
  const status = () => view.evaluate(() => document.getElementById('status').textContent);
  const until = async (predicate, arg, message) => {
    try { await view.waitForFunction(predicate, arg, { timeout: 8000, polling: 50 }); } catch { throw new Error(message + ' The view says: ' + JSON.stringify(await status())); }
  };
  const cards = () => view.evaluate(() => document.querySelectorAll('.cap').length);
  const transform = () => view.evaluate(() => document.getElementById('drawing').style.transform);
  const colours = () => view.evaluate(() => [...document.getElementById('colour').options].filter(option => !option.hidden).map(option => option.value));
  const inspector = () => view.evaluate(() => ({
    headings: [...document.querySelectorAll('#inspector h3')].map(node => node.textContent),
    relations: [...document.querySelectorAll('#inspector .relation')].map(node => node.textContent),
    text: document.getElementById('inspector').textContent,
  }));
  const select = id => view.evaluate(value => document.querySelector(`.cap[data-id="${value}"]`).click(), id);
  const results = {};

  // The shipped model opens at two levels, and each level shows the cards it should.
  await until(() => /635 total$/.test(document.getElementById('status').textContent), null, 'The map never loaded the 635-capability model.');
  assert(await status() === '48 shown · 635 in scope · 635 total', 'The map did not open at two levels: ' + await status());

  // BCM binds every part, so it keeps every colour mode, its banner and its own words (W-077).
  assert(JSON.stringify(await colours()) === JSON.stringify(['maturity', 'gap', 'importance', 'investment', 'none']),
    'BCM lost a colour mode: ' + JSON.stringify(await colours()));
  const banner = await view.evaluate(() => ({ hidden: document.getElementById('banner').hidden, text: document.getElementById('banner').textContent }));
  assert(!banner.hidden && banner.text === 'NORTHSTAR / DEMONSTRATION MODELFictional data · replace with your organisation', 'BCM lost its banner: ' + JSON.stringify(banner));
  assert(await view.evaluate(() => document.getElementById('notice').hidden), 'BCM shows a notice: ' + await view.evaluate(() => document.getElementById('notice').textContent));
  await select('bcm-cap-3-3');
  results.bcmInspector = await inspector();
  // In BCM's order, which its configuration gives; the host lists record types by ID, initiatives first.
  assert(JSON.stringify(results.bcmInspector.headings) === JSON.stringify(['Assessment', '2 child capabilities', 'Application support', 'Change portfolio']),
    'The inspector’s sections are not in BCM’s order: ' + JSON.stringify(results.bcmInspector.headings));
  for (const expected of ['Strong fit · Primary', 'Delivery · 2026-08-28']) {
    assert(results.bcmInspector.relations.some(text => text.endsWith(expected)), `No related row reads "${expected}": ${JSON.stringify(results.bcmInspector.relations)}`);
  }
  // Back to the enterprise, with nothing selected, for what follows.
  await view.evaluate(() => document.querySelector('#breadcrumbs button').click());
  await until(() => document.querySelectorAll('.cap.selected').length === 0, null, 'Returning to the enterprise kept a card selected.');

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
  const renamed = clone(bcm);
  renamed.records['bcm.capability'].find(r => r.recordId === 'bcm-cap-1').values['cap.name'] = 'Strategy & governance (renamed)';
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, renamed);
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

  // The view's definition changing binds again: without importance, its colour mode goes, and
  // it comes back with it. Nothing is read from the definition the view started with.
  const withoutImportance = clone(bcm);
  delete withoutImportance.context.configuration.fields.importance;
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushContext(); }, withoutImportance);
  await until(() => document.querySelector('#colour option[value="importance"]').hidden, null, 'A definition without importance kept its colour mode.');
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushContext(); }, bcm);
  await until(() => !document.querySelector('#colour option[value="importance"]').hidden, null, 'Importance did not come back with its binding.');

  // The map is the tree the file declares (ADR-0019 stage 7): a file that declares none says so
  // and draws nothing, rather than building a tree the Engine does not keep.
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, undeclared(bcm));
  await until(() => !document.getElementById('notice').hidden && /does not keep capabilities as a tree/.test(document.getElementById('notice').textContent),
    null, 'A file without the hierarchy did not say why there is no map.');
  results.undeclared = { cards: await cards(), empty: await view.evaluate(() => document.getElementById('empty').hidden),
    notice: await view.evaluate(() => document.getElementById('notice').textContent) };
  assert(results.undeclared.cards === 0, `A file without the hierarchy still drew ${results.undeclared.cards} cards.`);
  assert(results.undeclared.notice.includes('Declare Parent capability as the hierarchy of Capability'), 'The notice did not name the reference to declare: ' + results.undeclared.notice);
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, bcm);
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
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/bcm-atlas.png' });

  // ---- A second file (W-077). Nothing in it is BCM's: the record type, every field ID and the
  // choice IDs differ, the view binds no target, investment, owner, review date or evidence, and
  // its configuration names a Notes field the view does not bind. Opened in a fresh frame, as
  // another file's view would be.
  await page.setViewportSize({ width: 1280, height: 800 });
  const readFrom = (await page.evaluate(() => window.broker.requests)).length;
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.remount(); }, fixtures.other);
  await attach();
  await until(() => /18 total$/.test(document.getElementById('status').textContent), null, 'The second file never loaded its 18 areas.');
  assert(await status() === '12 shown · 18 in scope · 18 total', 'The second file did not open at two levels: ' + await status());
  for (const [level, count] of Object.entries({ 1: 3, 2: 12, 3: 18, Infinity: 18 })) {
    await view.click(`[data-level="${level}"]`);
    assert(await cards() === count, `In the second file, levels ${level} shows ${await cards()} cards, not ${count}.`);
  }
  await view.click('[data-level="2"]');
  const reads = (await page.evaluate(() => window.broker.requests)).slice(readFrom).filter(r => r.m.startsWith('records.'));
  const readTypes = [...new Set(reads.map(r => r.p.entityId))].sort();
  assert(JSON.stringify(readTypes) === JSON.stringify(['org.area', 'org.project', 'org.use']), 'The second file was read as other record types: ' + JSON.stringify(readTypes));
  assert(reads.some(r => r.m === 'records.tree' && r.p.entityId === 'org.area'), 'The second file was not read as its own tree.');

  // What the view does not bind is not offered, and what it binds wrongly is named.
  results.other = { colours: await colours() };
  assert(JSON.stringify(results.other.colours) === JSON.stringify(['maturity', 'importance', 'none']),
    'Without target or investment the colour modes should be maturity, importance and neutral: ' + JSON.stringify(results.other.colours));
  results.other.figures = await view.evaluate(() => ({ gaps: document.getElementById('gaps').parentElement.hidden,
    unassessed: document.getElementById('unassessed').parentElement.hidden, banner: document.getElementById('banner').hidden }));
  assert(JSON.stringify(results.other.figures) === JSON.stringify({ gaps: true, unassessed: false, banner: true }),
    'The figures do not follow the bindings: ' + JSON.stringify(results.other.figures));
  results.other.notice = await view.evaluate(() => document.getElementById('notice').hidden ? null : document.getElementById('notice').textContent);
  assert(results.other.notice === 'Definition is set to Notes, which this view does not bind. Bind Notes to the view, or take description out of its configuration.',
    'The unbound Notes field was not named: ' + JSON.stringify(results.other.notice));
  assert(await view.evaluate(() => document.querySelector('.cap[data-id="org-a-2"] .score').textContent) === '3 / 5', 'The card does not score the bound Capability level.');
  await view.selectOption('#colour', 'importance');
  results.other.legend = await view.evaluate(() => document.getElementById('legend').textContent);
  assert(results.other.legend === 'CommodityCoreEdge', 'The legend does not name the file’s own choices: ' + results.other.legend);
  assert(await view.evaluate(() => document.querySelector('.cap[data-id="org-a-2"]').style.getPropertyValue('--tone')) === 'var(--nendo-tone-violet)',
    'An Edge area is not drawn in the tone the schema gives Edge.');

  // The inspector finds what refers to an area through the schema: a link type and a record list.
  await select('org-a-1');
  results.other.inspector = await inspector();
  assert(JSON.stringify(results.other.inspector.headings) === JSON.stringify(['Assessment', '2 child capabilities', 'System use', 'Project']),
    'The second file’s inspector sections: ' + JSON.stringify(results.other.inspector.headings));
  for (const row of ['Relay CRMGood', 'StorefrontFair', 'Loyalty relaunchBuild']) {
    assert(results.other.inspector.relations.includes(row), `No related row "${row}": ${JSON.stringify(results.other.inspector.relations)}`);
  }
  assert(!results.other.inspector.text.includes('No definition yet'), 'An unbound definition was offered in the inspector.');

  // The editor offers what the view binds and writes the file's own fields: a new child of
  // Customers 1, with the parent's version. The broker answers no writes, so the save is
  // refused and the draft stays.
  await view.evaluate(() => [...document.querySelectorAll('#inspector button')].find(b => b.textContent === '+ Child').click());
  await until(() => document.getElementById('editor').open, null, 'The editor did not open for a new child.');
  results.other.editor = await view.evaluate(() => [...document.querySelectorAll('#edit-form label')].filter(label => !label.hidden).map(label => label.firstChild.textContent.trim()));
  assert(JSON.stringify(results.other.editor) === JSON.stringify(['Name', 'Reference', 'Parent capability', 'Maturity', 'Strategic importance', 'Lifecycle']),
    'The editor offers inputs the view does not bind: ' + JSON.stringify(results.other.editor));
  await view.fill('[name="name"]', 'Pilot area');
  await view.selectOption('[name="maturity"]', '2');
  await view.click('#save');
  await until(() => document.getElementById('form-error').textContent.includes('not been saved'), null, 'The refused save did not say so.');
  const created = (await page.evaluate(() => window.broker.requests)).filter(r => r.m === 'records.create').at(-1);
  assert(created !== undefined, 'The editor sent no create.');
  results.other.create = created.p;
  assert(created.p.entityId === 'org.area', 'The create named another record type: ' + created.p.entityId);
  assert(JSON.stringify(Object.keys(created.p.values).sort()) === JSON.stringify(['area.focus', 'area.key', 'area.level', 'area.state', 'area.title', 'area.up']),
    'The create wrote fields the view does not bind, or missed one: ' + JSON.stringify(created.p.values));
  assert(created.p.values['area.up'] === 'org-a-1' && created.p.values['area.state'] === 'draft' && created.p.values['area.level'] === 2 && created.p.values['area.title'] === 'Pilot area',
    'The create carried the wrong values: ' + JSON.stringify(created.p.values));
  assert(JSON.stringify(created.p.targetVersions) === JSON.stringify({ 'area.up': 1 }), 'The create did not carry the parent’s version: ' + JSON.stringify(created.p.targetVersions));
  assert(await view.evaluate(() => document.getElementById('editor').open && document.querySelector('[name="name"]').value === 'Pilot area'), 'The refused save lost the draft.');
  await view.evaluate(() => document.getElementById('editor').close());
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/bcm-atlas-other-file.png' });

  const everything = [...new Set((await page.evaluate(() => window.broker.requests)).slice(readFrom).map(r => r.p?.entityId).filter(Boolean))];
  assert(everything.every(entityId => entityId.startsWith('org.')), 'The second file was asked about BCM’s record types: ' + JSON.stringify(everything));
  assert(errors.length === 0, 'The view raised: ' + errors.join(' | '));
  return 'bcm-atlas ok ' + JSON.stringify(results);
}
