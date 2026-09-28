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

  // W-078: an export hands its file to an anchor with a download name. The view's anchors are
  // caught before the browser saves anything, and each file is read back from its blob in the view.
  const catchDownloads = () => view.evaluate(() => {
    window.__exports = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__exports.push({ name: this.download, href: this.href }); return; }
      return click.call(this);
    };
  });
  const exported = (format, light) => view.evaluate(async ({ format, light }) => {
    const before = window.__exports.length;
    document.getElementById('export').open = true;
    document.getElementById('export-light').checked = light;
    document.querySelector(`[data-export="${format}"]`).click();
    for (let i = 0; i < 200 && window.__exports.length === before; i += 1) await new Promise(resolve => setTimeout(resolve, 25));
    if (window.__exports.length === before) return null;
    const file = window.__exports.at(-1);
    const blob = await (await fetch(file.href)).blob();
    if (format === 'png') {
      const bitmap = await createImageBitmap(blob);
      return { name: file.name, type: blob.type, width: bitmap.width, height: bitmap.height };
    }
    const text = await blob.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const shapes = [...doc.querySelectorAll('g.card rect.card-shape')].map(r => ['x', 'y', 'width', 'height'].map(k => Number(r.getAttribute(k))));
    return {
      name: file.name, type: blob.type, text, broken: doc.querySelector('parsererror') !== null,
      width: Number(doc.documentElement.getAttribute('width')), height: Number(doc.documentElement.getAttribute('height')),
      names: [...doc.querySelectorAll('g.card > title')].map(node => node.textContent),
      span: [Math.max(...shapes.map(s => s[0] + s[2])) - Math.min(...shapes.map(s => s[0])), Math.max(...shapes.map(s => s[1] + s[3])) - Math.min(...shapes.map(s => s[1]))],
      legend: [...doc.querySelectorAll('g.legend text')].map(node => node.textContent),
      background: doc.querySelector('rect.background')?.getAttribute('fill') ?? null,
      heading: doc.querySelector('text.heading')?.textContent ?? null,
      texts: doc.querySelectorAll('text').length,
    };
  }, { format, light });
  // What the map packs, read off its cards' own coordinates rather than the screen's.
  const packed = () => view.evaluate(() => {
    const cards = [...document.querySelectorAll('.cap')];
    const at = key => cards.map(card => parseFloat(card.style[key]));
    const lefts = at('left'), tops = at('top'), widths = at('width'), heights = at('height');
    return {
      names: cards.map(card => card.querySelector('.cap-title').textContent),
      span: [Math.max(...lefts.map((l, i) => l + widths[i])) - Math.min(...lefts), Math.max(...tops.map((top, i) => top + heights[i])) - Math.min(...tops)],
      legend: [...document.querySelectorAll('#legend span')].map(span => span.textContent),
    };
  });

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

  // W-078: Export writes what the map packs, with its legend and title, as SVG and PNG.
  await catchDownloads();
  const map = await packed();
  const svg = await exported('svg', false);
  assert(svg !== null, 'Export SVG handed no file to the browser.');
  assert(!svg.broken && svg.type === 'image/svg+xml' && /^capability-map-enterprise-\d{4}-\d{2}-\d{2}\.svg$/.test(svg.name), `The export is not a well-formed SVG file: ${svg.type} ${svg.name}`);
  assert(JSON.stringify(svg.names) === JSON.stringify(map.names), `The SVG holds ${svg.names.length} cards; the map shows ${map.names.length}.`);
  assert(JSON.stringify(svg.span) === JSON.stringify(map.span), `The SVG's cards span ${svg.span}; the map's span ${map.span}.`);
  assert(JSON.stringify(svg.legend) === JSON.stringify(map.legend), 'The SVG\u2019s legend is not the map\u2019s: ' + JSON.stringify(svg.legend));
  assert(svg.heading === 'Capability map' && svg.texts > map.names.length, `The SVG's text is not text: ${svg.texts} text elements.`);
  assert(!/var\(|<style|foreignObject/.test(svg.text), 'The SVG uses what a slide editor may not keep.');
  assert(svg.background === '#f3f4f6', 'The light theme\u2019s export is not on the light canvas: ' + svg.background);
  results.export = { name: svg.name, width: svg.width, height: svg.height, cards: svg.names.length };
  // The camera plays no part: zoomed in and panned, the same file.
  await view.click('#zoom-in');
  await view.click('#zoom-in');
  await view.focus('#map');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  assert((await exported('svg', false)).text === svg.text, 'Zooming and panning changed the exported SVG; the export follows the camera.');
  await view.click('#fit');
  // PNG: the same document drawn at twice its size, for a slide.
  const png = await exported('png', false);
  assert(png !== null && png.type === 'image/png' && /\.png$/.test(png.name), `The PNG export is ${png?.type} ${png?.name}.`);
  assert(png.width === Math.round(svg.width * 2) && png.height === Math.round(svg.height * 2), `The PNG is ${png.width}\u00d7${png.height}, not twice ${svg.width}\u00d7${svg.height}.`);
  results.export.png = [png.width, png.height];
  // In the dark theme the export takes the dark canvas; Light colours for print, white paper and dark ink.
  await page.evaluate(value => window.broker.pushTheme(value), 'dark');
  await until(value => getComputedStyle(document.documentElement).backgroundColor === value, 'rgb(15, 17, 21)', 'The dark theme never reached the view.');
  const dark = await exported('svg', false), print = await exported('svg', true);
  assert(dark.background === '#0f1115', 'The dark theme\u2019s export is not on the dark canvas: ' + dark.background);
  assert(print.background === '#ffffff' && print.text.includes('fill="#14171c"'), 'Light colours for print did not give white paper and dark ink.');
  await page.evaluate(value => window.broker.pushTheme(value), 'light');
  await until(value => getComputedStyle(document.documentElement).backgroundColor === value, 'rgb(243, 244, 246)', 'The light theme never came back.');
  assert(await view.evaluate(() => window.__bcmLayouts) === 1, 'Exporting packed the map again; it must write the packing it has.');

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

  // ---- W-079: moving and renaming on the map, with the real pointer and keyboard. The fixture
  // broker moves as the Engine does: the versions read, no loop, the place among the siblings.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await view.click('[data-level="2"]');
  await view.click('#fit');
  await page.waitForTimeout(200);
  const moves = async () => (await page.evaluate(() => window.broker.requests)).filter(r => r.m === 'records.move');
  // A move's refresh redraws every card, so a card can be replaced while it is being measured.
  const box = async id => {
    let found = null;
    for (let attempt = 0; attempt < 20 && found === null; attempt += 1) {
      found = await view.locator(`.cap[data-id="${id}"]`).boundingBox();
      if (found === null) await page.waitForTimeout(100);
    }
    if (found === null) {
      const seen = await view.evaluate(value => { const node = document.querySelector(`.cap[data-id="${value}"]`); return node ? { style: node.getAttribute('style'), rect: node.getBoundingClientRect().toJSON() } : 'not in the page'; }, id);
      throw new Error(`The card ${id} has no box: ${JSON.stringify(seen)}. The view says: ${JSON.stringify(await status())}`);
    }
    return found;
  };
  const inside = (inner, outer) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
  const dragTo = async (id, at) => {
    const from = await box(id);
    await page.mouse.move(from.x + from.width / 2, from.y + Math.min(12, from.height / 2));
    await page.mouse.down();
    await page.mouse.move(at.x, at.y, { steps: 12 });
    await page.mouse.up();
  };
  // Each write sets off a refresh a moment later. Before the next step the view must have gone
  // quiet -- no request for 600ms -- or that refresh lands in the middle of it.
  const quiet = async () => {
    let last = -1, still = 0;
    while (still < 6) {
      const count = await page.evaluate(() => window.broker.requests.length);
      if (count === last) still += 1;
      else { still = 0; last = count; }
      await page.waitForTimeout(100);
    }
  };
  const children = parentId => view.evaluate(async parent => (await nendo.records.treeAll({ entityId: 'bcm.capability', rootRecordId: parent, depth: 1 }))
    .map(node => node.record.recordId), parentId);
  results.moves = {};

  // Onto a group's heading: the capability goes in, as its last child, with its subtree.
  let sent = (await moves()).length;
  const domain = await box('bcm-cap-2');
  await dragTo('bcm-cap-1-1', { x: domain.x + domain.width / 2, y: domain.y + 10 });
  for (let i = 0; i < 60 && (await moves()).length === sent; i += 1) await page.waitForTimeout(50);
  let move = (await moves()).slice(sent);
  assert(move.length === 1 && move[0].p.recordId === 'bcm-cap-1-1' && move[0].p.parentRecordId === 'bcm-cap-2' && move[0].p.parentVersion === 1 && !move[0].p.beforeRecordId,
    'A drag onto a group did not move the card into it: ' + JSON.stringify(move.map(r => r.p)) + ' The view says: ' + JSON.stringify(await status()));
  for (let i = 0; i < 40 && !inside(await box('bcm-cap-1-1'), await box('bcm-cap-2')); i += 1) await page.waitForTimeout(50);
  assert(inside(await box('bcm-cap-1-1'), await box('bcm-cap-2')), 'The moved card is not drawn inside the group it moved into.');
  assert((await children('bcm-cap-2')).at(-1) === 'bcm-cap-1-1', 'The moved card is not the group\u2019s last child: ' + JSON.stringify(await children('bcm-cap-2')));
  results.moves.into = move[0].p;

  // Onto a sibling's left edge: before it.
  await quiet();
  sent = (await moves()).length;
  const sibling = await box('bcm-cap-3-1');
  await dragTo('bcm-cap-3-3', { x: sibling.x + sibling.width * 0.12, y: sibling.y + sibling.height / 2 });
  for (let i = 0; i < 60 && (await moves()).length === sent; i += 1) await page.waitForTimeout(50);
  move = (await moves()).slice(sent);
  assert(move.length === 1 && move[0].p.parentRecordId === 'bcm-cap-3' && move[0].p.beforeRecordId === 'bcm-cap-3-1',
    'A drag onto a sibling\u2019s left edge did not place the card before it: ' + JSON.stringify(move.map(r => r.p)));
  const justBefore = async (parent, id, next) => { const kids = await children(parent); return kids[kids.indexOf(next) - 1] === id; };
  for (let i = 0; i < 40 && !(await justBefore('bcm-cap-3', 'bcm-cap-3-3', 'bcm-cap-3-1')); i += 1) await page.waitForTimeout(50);
  assert(await justBefore('bcm-cap-3', 'bcm-cap-3-3', 'bcm-cap-3-1'), 'The moved card is not just before the sibling: ' + JSON.stringify(await children('bcm-cap-3')));
  results.moves.before = move[0].p;

  // Into its own group: refused before anything is written, and said.
  await quiet();
  sent = (await moves()).length;
  const own = await box('bcm-cap-4-1');
  await dragTo('bcm-cap-4', { x: own.x + own.width / 2, y: own.y + own.height / 2 });
  await page.waitForTimeout(300);
  assert((await moves()).length === sent, 'A drag into its own group was sent to the file.');
  assert(/cannot move into its own group/.test(await status()), 'A drag into its own group did not say why: ' + await status());

  // The keyboard, from a selected card: up swaps with the sibling above, left takes it out after
  // its parent, and a first child has no sibling above to go into.
  await quiet();
  await view.click('.cap[data-id="bcm-cap-5-2"]');
  sent = (await moves()).length;
  await page.keyboard.press('Alt+Shift+ArrowUp');
  for (let i = 0; i < 60 && (await moves()).length === sent; i += 1) await page.waitForTimeout(50);
  move = (await moves()).slice(sent);
  assert(move.length === 1 && move[0].p.recordId === 'bcm-cap-5-2' && move[0].p.beforeRecordId === 'bcm-cap-5-1', 'Alt+Shift+Up did not move the card up: ' + JSON.stringify(move.map(r => r.p)));
  for (let i = 0; i < 40 && !(await justBefore('bcm-cap-5', 'bcm-cap-5-2', 'bcm-cap-5-1')); i += 1) await page.waitForTimeout(50);
  await quiet();
  sent = (await moves()).length;
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  for (let i = 0; i < 60 && (await moves()).length === sent; i += 1) await page.waitForTimeout(50);
  move = (await moves()).slice(sent);
  assert(move.length === 1 && move[0].p.parentRecordId === null && move[0].p.beforeRecordId === 'bcm-cap-6' && move[0].p.parentVersion === undefined,
    'Alt+Shift+Left did not take the card out after its parent: ' + JSON.stringify(move.map(r => r.p)));
  results.moves.keyboard = move[0].p;
  for (let i = 0; i < 40 && (await children(null)).indexOf('bcm-cap-5-2') === -1; i += 1) await page.waitForTimeout(50);
  await quiet();
  await view.click('.cap[data-id="bcm-cap-5-4"]');
  sent = (await moves()).length;
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await page.waitForTimeout(200);
  assert((await moves()).length === sent && /cannot move into the capability above/.test(await status()),
    'Alt+Shift+Right on a first child moved it, or said nothing: ' + await status());

  // F2 renames in place, with the version read.
  await quiet();
  await until(() => document.querySelector('.cap[data-id="bcm-cap-6-1"]') !== null, null, 'The card to rename is not drawn.');
  await view.click('.cap[data-id="bcm-cap-6-1"]');
  await page.keyboard.press('F2');
  await until(() => document.activeElement?.classList.contains('cap-rename'), null, 'F2 did not open the name for editing.');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('People and culture (renamed)');
  await page.keyboard.press('Enter');
  await until(() => [...document.querySelectorAll('.cap-title')].some(n => n.textContent === 'People and culture (renamed)'), null, 'The renamed card never showed its new name.');
  const rename = (await page.evaluate(() => window.broker.requests)).filter(r => r.m === 'records.update').at(-1);
  assert(rename.p.recordId === 'bcm-cap-6-1' && rename.p.values['cap.name'] === 'People and culture (renamed)' && Object.keys(rename.p.values).length === 1,
    'F2 wrote something other than the name: ' + JSON.stringify(rename.p));

  // A card somebody moved meanwhile: the drop is refused over the version read, and the map
  // then shows where the file holds it.
  const stale = clone(bcm);
  const moved = stale.records['bcm.capability'].find(r => r.recordId === 'bcm-cap-5-1');
  moved.values['cap.parent'] = 'bcm-cap-6';
  moved.version = 99;
  await quiet();
  await page.evaluate(value => window.broker.setFixture(value), stale);
  sent = (await moves()).length;
  const target = await box('bcm-cap-2');
  await dragTo('bcm-cap-5-1', { x: target.x + target.width / 2, y: target.y + 10 });
  await until(() => /was not moved: The record changed/.test(document.getElementById('status').textContent), null, 'A stale move was not refused in words.');
  assert((await moves()).length === sent + 1, 'The stale move was not sent once.');
  // A redraw that something else sets off must not write the counts over why the move failed.
  await page.evaluate(() => window.broker.pushChanges());
  await page.waitForTimeout(600);
  assert(/was not moved: The record changed/.test(await status()), 'A redraw after a refused move wrote over why it was refused: ' + await status());
  for (let i = 0; i < 40 && !inside(await box('bcm-cap-5-1'), await box('bcm-cap-6')); i += 1) await page.waitForTimeout(50);
  assert(inside(await box('bcm-cap-5-1'), await box('bcm-cap-6')), 'After the refusal the map does not show the card where the file holds it.');
  results.moves.stale = await status();
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/bcm-atlas-moved.png' });

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
  // The second file exports under its own view's title, with its own choices in the legend.
  await catchDownloads();
  const areas = await exported('svg', false), areaMap = await packed();
  assert(areas !== null && /^area-map-enterprise-/.test(areas.name) && areas.heading === 'Area map', `The second file's export is ${areas?.name} titled ${areas?.heading}.`);
  assert(JSON.stringify(areas.names) === JSON.stringify(areaMap.names) && JSON.stringify(areas.legend) === JSON.stringify(['Commodity', 'Core', 'Edge']),
    'The second file\u2019s export does not hold its map: ' + JSON.stringify({ names: areas.names.length, legend: areas.legend }));
  results.other.export = { name: areas.name, cards: areas.names.length };

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

  // ---- Nendo's own chrome (W-090). Everything above ran on a host that does not draw a view's
  // controls, where the Atlas draws its own. On one that does, the Atlas draws none: it declares
  // them, and Nendo draws them, lists them in Ctrl K and sends a press back as a command. It takes
  // Nendo's Add, and a right-click on a card asks for Nendo's menu. BCM again, in a fresh frame.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(value => { window.broker.offerChrome(true); window.broker.setFixture(value); window.broker.remount(); }, bcm);
  await attach();
  await until(() => /635 total$/.test(document.getElementById('status').textContent), null, 'With Nendo drawing its controls, the map never loaded.');
  const chrome = await view.evaluate(() => ({
    native: document.documentElement.classList.contains('native-chrome'),
    toolbar: getComputedStyle(document.querySelector('.toolbar')).display,
    subbar: getComputedStyle(document.querySelector('.subbar')).display,
    crumbs: document.querySelector('.metrics #breadcrumbs') !== null,
  }));
  assert(JSON.stringify(chrome) === JSON.stringify({ native: true, toolbar: 'none', subbar: 'none', crumbs: true }),
    'The Atlas still draws its own controls on a host that draws them: ' + JSON.stringify(chrome));
  const lastToolbar = () => page.evaluate(() => window.broker.toolbars.at(-1) ?? null);
  const declaredWhere = async (test, message) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const last = await lastToolbar();
      if (last !== null && test(last)) return last;
      await page.waitForTimeout(25);
    }
    throw new Error(message + ' The last toolbar declared: ' + JSON.stringify(await lastToolbar()).slice(0, 600));
  };
  const shape = toolbar => toolbar.items.map(item => item.kind === 'group'
    ? `group:${item.items.map(child => child.id + (child.keys ? '@' + child.keys : '')).join(',')}`
    : `${item.kind}${item.id ? ':' + item.id : ''}${item.keys ? '@' + item.keys : ''}`);
  let toolbar = await declaredWhere(() => true, 'The Atlas declared no toolbar.');
  results.chrome = { shape: shape(toolbar), add: toolbar.add };
  assert(JSON.stringify(results.chrome.shape) === JSON.stringify(['choice:mode', 'choice:levels', 'select:colour', 'spacer', 'search:find@Ctrl+F', 'separator',
    'toggle:pan', 'group:zoom-out@Ctrl+-,fit@Ctrl+0,zoom-in@Ctrl+Plus', 'text', 'menu:map-options', 'separator', 'menu:export']),
  'The Atlas declared another toolbar: ' + JSON.stringify(results.chrome.shape));
  assert(toolbar.add === 'add-capability', 'The Atlas did not take Nendo\u2019s Add: ' + JSON.stringify(toolbar.add));
  const levelItem = toolbar.items.find(item => item.id === 'levels');
  assert(JSON.stringify(levelItem.options.map(option => option.value)) === JSON.stringify(['1', '2', '3', '4', '5', 'all']) && levelItem.value === '2',
    'Levels were declared as ' + JSON.stringify(levelItem));
  assert(JSON.stringify(toolbar.items.find(item => item.id === 'colour').options.map(option => option.value)) === JSON.stringify(['maturity', 'gap', 'importance', 'investment', 'none']),
    'BCM\u2019s colour modes were not all declared.');

  // A command is a press of the control it stands for, and the toolbar follows the state.
  await page.evaluate(() => window.broker.command('levels', '3'));
  await until(() => document.querySelectorAll('.cap').length === 267, null, 'The levels command did not show three levels.');
  await declaredWhere(last => last.items.find(item => item.id === 'levels')?.value === '3', 'The toolbar did not follow the levels.');
  await page.evaluate(() => window.broker.command('mode', 'assessment'));
  await until(() => !document.getElementById('table').hidden && document.getElementById('map').hidden, null, 'The mode command did not show the assessment.');
  toolbar = await declaredWhere(last => last.items.find(item => item.id === 'mode')?.value === 'assessment', 'The toolbar did not follow the mode.');
  assert(!toolbar.items.some(item => item.id === 'export' || item.id === 'pan'), 'The assessment still declares the map\u2019s controls.');
  await page.evaluate(() => window.broker.command('mode', 'map'));
  await until(() => !document.getElementById('map').hidden, null, 'The mode command did not return to the map.');
  await page.evaluate(() => window.broker.command('find', 'payr'));
  await until(() => /^\d+ matches/.test(document.getElementById('status').textContent), null, 'The find command did not search.');
  await page.evaluate(() => window.broker.command('find', ''));
  await until(() => /total$/.test(document.getElementById('status').textContent), null, 'Emptying the search did not show the counts again.');
  // The API sends a declaration at most every tenth of a second, so wait for the map's own.
  const zoomText = (await declaredWhere(last => last.items.find(item => item.id === 'mode')?.value === 'map' && last.items.some(item => item.kind === 'text'),
    'The toolbar did not return to the map’s controls.')).items.find(item => item.kind === 'text').text;
  const beforeZoom = await transform();
  await page.evaluate(() => window.broker.command('zoom-in', null, 'key'));
  await until(value => document.getElementById('drawing').style.transform !== value, beforeZoom, 'The zoom-in command did not zoom.');
  await declaredWhere(last => last.items.find(item => item.kind === 'text')?.text !== zoomText, 'The toolbar\u2019s zoom did not follow the camera.');
  await page.evaluate(() => window.broker.command('pan', true));
  await until(() => document.getElementById('map').classList.contains('pan-ready'), null, 'The pan command did not turn Pan on.');
  await page.evaluate(() => window.broker.command('pan', false));
  await until(() => !document.getElementById('map').classList.contains('pan-ready'), null, 'The pan command did not turn Pan off.');

  // Nendo's Add adds under the selected card, in the Atlas's own editor.
  await select('bcm-cap-2-3');
  await page.evaluate(() => window.broker.command('add-capability', null, 'add'));
  await until(() => document.getElementById('editor').open, null, 'Nendo\u2019s Add did not open the Atlas\u2019s editor.');
  results.chrome.addParent = await view.evaluate(() => document.querySelector('[name="parent"]').value);
  assert(results.chrome.addParent === 'bcm-cap-2-3', 'Nendo\u2019s Add did not add under the selected card: ' + results.chrome.addParent);
  await view.evaluate(() => document.getElementById('editor').close());

  // A right-click on a group asks Nendo for its menu at the pointer, and the pick is carried out.
  const menusBefore = (await page.evaluate(() => window.broker.menus)).length;
  await page.evaluate(() => window.broker.pickNext({ id: 'focus', value: null }));
  const browserMenu = await view.evaluate(() => {
    const card = document.querySelector('.cap[data-id="bcm-cap-2"]');
    const box = card.getBoundingClientRect();
    return card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 10, clientY: box.top + 10, button: 2 }));
  });
  assert(browserMenu === false, 'The browser\u2019s own menu was left to open over Nendo\u2019s.');
  let menu = null;
  for (let attempt = 0; attempt < 100 && menu === null; attempt += 1) {
    const all = await page.evaluate(() => window.broker.menus);
    if (all.length > menusBefore) menu = all.at(-1); else await page.waitForTimeout(25);
  }
  assert(menu !== null, 'A right-click on a card asked Nendo for no menu.');
  results.chrome.menu = menu.items.map(item => item.id ?? item.kind);
  assert(JSON.stringify(results.chrome.menu) === JSON.stringify(['open', 'edit', 'add-child', 'rename', 'focus', 'separator', 'move-up', 'move-down', 'move-in', 'move-out']),
    'The card menu holds ' + JSON.stringify(results.chrome.menu));
  assert(menu.x > 0 && menu.y > 0, 'The menu was not asked for at the pointer: ' + JSON.stringify([menu.x, menu.y]));
  await until(() => document.getElementById('breadcrumbs').textContent.includes('Customer & market'), null, 'Picking Focus this group did not focus it.');
  // The fixture read every toolbar and menu above by the Workbench's own rules (W-091).
  const refused = await page.evaluate(() => window.broker.chromeRefusals);
  assert(refused.length === 0, 'Nendo would refuse what the Atlas declared or asked for: ' + JSON.stringify(refused));
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/bcm-atlas-native-chrome.png' });
  await page.evaluate(() => window.broker.offerChrome(false));
  assert(errors.length === 0, 'The view raised with Nendo\u2019s chrome: ' + errors.join(' | '));

  // W-078: the exported SVG opens in a browser as it stands, at its own size, and is kept for a look.
  await page.setViewportSize({ width: Math.min(svg.width, 1600), height: Math.min(svg.height, 1200) });
  await page.setContent(`<body style="margin:0">${svg.text.replace(/^<\?xml[^>]*>\s*/, '')}</body>`);
  const opened = await page.evaluate(() => { const box = document.querySelector('svg').getBoundingClientRect(); return [box.width, box.height, document.querySelectorAll('svg g.card').length]; });
  assert(opened[0] === svg.width && opened[1] === svg.height && opened[2] === svg.names.length, `The exported SVG opened at ${opened}, not ${svg.width}×${svg.height} with ${svg.names.length} cards.`);
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/bcm-atlas-export.png' });
  return 'bcm-atlas ok ' + JSON.stringify(results);
}
