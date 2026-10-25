async page => {
  // The Deck view in the fixture broker, measured where the person meets it. tools/Review-Deck.ps1
  // fills the placeholders and runs this with playwright-cli. A failure names the last check that
  // passed, so a timeout says where it happened.
  const checks = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`Browser dialog (${dialog.type()}): ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__BROKER_URL__');
  const fixture = '__DECK_FIXTURE__';
  const empty = '__DECK_EMPTY_FIXTURE__';
  await page.waitForFunction(() => window.broker && window.toolbarRules);
  await page.evaluate(fixture => {
    window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.offerPlaces(true); window.broker.offerMediaPut(true);
    window.broker.offerAssistant({ state: 'ready', name: 'Agent', working: false, access: 'always' });
    window.broker.setFixture(fixture);
  }, fixture);
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  const mounted = async () => {
    for (let i = 0; i < 200; i++) { const f = page.frames().find(f => f.url().startsWith(origin + '/')); if (f) return f; await page.waitForTimeout(50); }
    throw Error('Deck frame did not mount.');
  };
  let frame = await mounted();
  // The view is a module: a module that does not parse never runs, and the view never says ready.
  const ready = () => frame.waitForFunction(() => window.deck?.ready === true, null, { timeout: 15000 })
    .catch(() => { throw Error('The Deck view never said it was ready: a module of the package failed to load or to run.'); });
  await ready();
  const command = (id, value = null) => page.evaluate(({ id, value }) => window.broker.command(id, value), { id, value });
  const records = entity => page.evaluate(entity => window.broker.records(entity), entity);
  const record = (entity, id) => page.evaluate(({ entity, id }) => window.broker.record(entity, id), { entity, id });
  const requests = method => page.evaluate(method => window.broker.requests.filter(r => r.m === method).map(r => r.p), method);
  const state = () => frame.evaluate(() => ({ slides: window.deck.slides.map(s => ({ id: s.id, order: s.order, layout: s.layout, title: s.title })), slideId: window.deck.slideId, problem: window.deck.problem }));
  const settle = (ms = 600) => page.waitForTimeout(ms);
  const until = (fn, arg, ms = 5000) => frame.waitForFunction(fn, arg, { timeout: ms });
  const exampleSlides = fixture.records['dk.slide'].length;
  /**
   * A slide dragged with the pointer, as a person drags it: pressed, moved past the threshold, and
   * dropped before another (by index), or past the end (null), which it reaches only by holding the
   * pointer at the list's foot until the list has scrolled there. `ctrl` copies; `list` is the slide
   * list or the sorter. Answers what the view said while the slide was in the air.
   */
  const dragSlide = async (fromIndex, beforeIndex, { ctrl = false, list = '#slides', release = true } = {}) => {
    const item = i => frame.locator(`${list} li[data-id]`).nth(i);
    // Slides still sliding into place from the last move are measured where they come to rest.
    await frame.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => null))));
    // A redraw still on its way may scroll the list back to the current slide: the slide is pressed
    // once it stays in view.
    let from = null;
    for (let i = 0; i < 20; i++) {
      await item(fromIndex).evaluate(el => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(80);
      from = await item(fromIndex).boundingBox();
      const shown = await frame.locator(list).boundingBox();
      if (from && from.y >= shown.y && from.y + from.height <= shown.y + shown.height) break;
    }
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 3, from.y + from.height / 2 + 9, { steps: 3 });
    const box = await frame.locator(list).boundingBox();
    if (beforeIndex === null) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3, { steps: 4 });
      await frame.waitForFunction(sel => { const l = document.querySelector(sel); return l.scrollTop + l.clientHeight >= l.scrollHeight - 1; }, list, { timeout: 8000 })
        .catch(() => { throw Error('Holding a dragged slide at the foot of the list must scroll the list to its end.'); });
      await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height - 4);
    } else {
      let to = null;
      for (let i = 0; i < 20 && !to; i++) { await item(beforeIndex).evaluate(el => el.scrollIntoView({ block: 'center' })); to = await item(beforeIndex).boundingBox(); }
      await page.mouse.move(to.x + to.width * (list === '#grid' ? 0.2 : 0.5), to.y + to.height * (list === '#grid' ? 0.5 : 0.25), { steps: 5 });
    }
    if (ctrl) await page.keyboard.down('Control');
    const air = await frame.evaluate(() => ({ drag: { ...window.deck.drag }, mark: !!document.querySelector('.drop-mark:not([hidden])'), ghost: document.querySelector('.drag-ghost .ghost-count')?.textContent ?? null,
      copy: !!document.querySelector('.drag-ghost.copy'), lifted: document.querySelectorAll('li.lifted').length }));
    if (!release) return air;
    await page.mouse.up();
    if (ctrl) await page.keyboard.up('Control');
    return air;
  };

  // 1. Mounted: the example's slides in order, Nendo's rules accept the toolbar, Add is the view's.
  assert(await frame.locator('#slides li').count() === exampleSlides, `The slide list must show the ${exampleSlides} example slides.`);
  const refusals = await page.evaluate(() => window.broker.chromeRefusals);
  assert(refusals.length === 0, 'Nendo refused a Deck toolbar declaration: ' + JSON.stringify(refusals));
  const toolbars = await page.evaluate(() => window.broker.toolbars);
  assert(toolbars.length > 0 && toolbars.at(-1).add === 'add.default', `The toolbar must hand Add to the view's add command: ${JSON.stringify(toolbars.at(-1)?.add)}.`);
  assert(await frame.locator('#own-toolbar').isHidden(), 'With Nendo\'s toolbar offered the view draws no controls of its own.');
  checks.push('mount');

  // 2. Every thumbnail draws its slide from its own top left corner. A scaled slide whose transform
  // pivots on its centre lands outside its box, and the box shows nothing.
  const misplaced = await frame.evaluate(() => [...document.querySelectorAll('.thumb')].map(t => {
    const box = t.getBoundingClientRect(), slide = t.firstElementChild.getBoundingClientRect();
    return { where: t.closest('#slides') ? 'list' : t.closest('#layouts') ? 'layouts' : t.closest('#templates') ? 'templates' : 'other', dx: Math.abs(box.left - slide.left), dy: Math.abs(box.top - slide.top), dw: Math.abs(box.width - slide.width) };
  }).filter(m => m.dx > 1 || m.dy > 1 || m.dw > 1));
  assert(await frame.locator('#layouts .thumb').count() === 21, 'The layout gallery must draw all twenty-one layouts.');
  assert(misplaced.length === 0, `Thumbnails must draw their slide inside their own box: ${JSON.stringify(misplaced.slice(0, 4))}.`);
  // An idle ask bar shows no working mark: a toggle given undefined flips the class instead.
  assert(!await frame.evaluate(() => document.getElementById('ask-status').classList.contains('working')), 'The ask bar must not show the agent working before anything was asked.');
  checks.push('thumbnails and idle ask bar');

  // 3. The example deck fits: no slide runs over at its smallest size, and the stage keeps the shape.
  const over = [];
  for (let i = 0; i < exampleSlides; i++) {
    await frame.evaluate(i => document.querySelectorAll('#slides li')[i].click(), i);
    const fit = await frame.evaluate(() => ({ warning: !document.getElementById('fit-warning').hidden, w: document.getElementById('stage').getBoundingClientRect().width, h: document.getElementById('stage').getBoundingClientRect().height, title: window.deck.slides.find(s => s.id === window.deck.slideId)?.title }));
    if (fit.warning) over.push(fit.title);
    assert(Math.abs(fit.w / fit.h - 16 / 9) < 0.01, `The stage must keep 16:9: ${fit.w}×${fit.h}.`);
  }
  assert(over.length === 0, `Every example slide must fit: ${over.join(', ')}.`);
  checks.push('every example slide fits');

  // 18. Stage first: the layouts are a row right under the slide, as wide as it, and the slide is
  // sized to the height the row leaves it, so neither runs past the centre: in a window where the
  // width sizes the slide, a narrow tall one, and a wide short one where the height does. The row
  // stays while another tab of the inspector is open.
  const stageFirst = () => frame.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    const stage = r('stage'), strip = r('layout-strip'), wrap = r('stage-wrap');
    return { gap: strip.top - stage.bottom, left: Math.abs(strip.left - stage.left), width: Math.abs(strip.width - stage.width), below: wrap.bottom - strip.bottom,
      stageW: stage.width, shape: stage.width / stage.height, inInspector: !!document.getElementById('layouts').closest('#inspector'), fit: document.getElementById('fit-text').textContent, layout: document.getElementById('fit-layout').textContent };
  });
  for (const size of [{ width: 1440, height: 900 }, { width: 1160, height: 1280 }, { width: 1600, height: 760 }]) {
    await page.setViewportSize(size);
    await settle(300);
    const m = await stageFirst();
    assert(m.gap >= 0 && m.gap <= 24, `The layouts must sit right under the slide at ${size.width}×${size.height}: ${m.gap.toFixed(1)} px between them.`);
    assert(m.below >= 0, `The slide and its layouts must fit the centre at ${size.width}×${size.height}: the row runs ${(-m.below).toFixed(1)} px past it.`);
    assert(Math.abs(m.shape - 16 / 9) < 0.01, `The slide must keep 16:9 over its layouts at ${size.width}×${size.height}: ${m.shape.toFixed(3)}.`);
    assert(m.stageW < 480 || (m.left <= 1 && m.width <= 1), `The row of layouts must be as wide as the slide at ${size.width}×${size.height}: ${JSON.stringify(m)}.`);
    assert(!m.inInspector && m.fit === 'Everything fits' && m.layout === 'Closing', `The Slide tab must say the slide fits and name its layout: ${JSON.stringify(m)}.`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame.click('#tab-design');
  assert(await frame.locator('#layouts').isVisible() && await frame.locator('#design-name').isHidden(), 'The layouts must stay under the slide while the Design tab is open.');
  await frame.click('#tab-slide');
  assert(await frame.locator('#design-name').textContent() === 'Keynote', `The Slide tab must name the deck's design: ${await frame.locator('#design-name').textContent()}.`);
  checks.push('stage first');

  // 4. Typing is the slide at once and a save after a pause, with the version it read.
  await frame.evaluate(() => document.querySelectorAll('#slides li')[4].click());
  const slide5 = (await state()).slideId;
  await frame.fill('#f-title', 'Typed title');
  // The stage redraws within a frame or two of the typing; the save waits for a pause.
  await until(() => document.querySelector('#stage [data-role="title"]')?.textContent === 'Typed title', null, 400)
    .catch(() => { throw Error('The stage must show the typing within 400 ms.'); });
  assert((await requests('records.update')).length === 0, 'The typing must not be saved before the pause.');
  await until(id => window.deck.pending.has(id) === false, slide5);
  const saved = await record('dk.slide', slide5);
  assert(saved.values['dk.slide.title'] === 'Typed title' && saved.version === 2, `The typing must be saved once, on version 1: ${JSON.stringify({ title: saved.values['dk.slide.title'], version: saved.version })}.`);
  checks.push('typing saves');

  // 5. Add, move and delete, each one revision that Nendo offers to undo.
  await command('add.12');
  await until(n => window.deck.slides.length === n, exampleSlides + 1);
  let s = await state();
  const added = s.slides.findIndex(x => x.id === s.slideId);
  assert(s.slides[added].layout === 'Big numbers' && added === 5, `Add puts the slide after the current one, in the layout picked: ${JSON.stringify(s.slides[added])} at ${added}.`);
  await command('slide.down');
  await until(i => window.deck.slides[i]?.id === window.deck.slideId, added + 1);
  s = await state();
  assert(s.slides.every((x, i) => i === 0 || x.order > s.slides[i - 1].order), 'Orders must rise down the list after a move.');
  // Typing, then a move: the move waits for the save the blur started, and moves on the first press.
  await frame.fill('#f-title', 'Typed just before a move');
  await page.evaluate(() => window.broker.hold('records.update', 600));
  await frame.evaluate(() => document.activeElement.blur());
  await command('slide.up');
  await until(i => window.deck.slides[i]?.id === window.deck.slideId, added, 3000)
    .catch(async () => { const now = await state(); throw Error(`A move right after typing must move on the first press: the slide is at ${now.slides.findIndex(x => x.id === now.slideId) + 1}, not ${added + 1}.`); });
  // A delete the file refuses keeps the typing that was waiting for its save.
  await frame.fill('#f-title', 'Typed before a refused delete');
  await page.evaluate(() => window.broker.fail('records.batch', { code: 'busy', message: 'The file is busy.' }));
  await command('slide.delete');
  await settle(1200);
  const refusedDelete = await record('dk.slide', s.slideId);
  assert(refusedDelete.values['dk.slide.title'] === 'Typed before a refused delete', `A refused delete must keep the slide's typing: ${JSON.stringify(refusedDelete.values['dk.slide.title'])}.`);
  // Typing, then Delete from the host's menu: the frame's blur starts the save, and the delete waits for it.
  await frame.fill('#f-title', 'Typed just before delete');
  await page.evaluate(() => window.broker.hold('records.update', 600));
  await frame.evaluate(() => document.activeElement.blur());
  await command('slide.delete');
  await until(n => window.deck.slides.length === n, exampleSlides, 3000)
    .catch(async () => { throw Error(`A delete right after typing must delete on the first press: ${(await state()).slides.length} slides, not ${exampleSlides}.`); });
  // A thumbnail dragged with the pointer to the list's foot scrolls the list and goes to the end,
  // then back before the second.
  const moved = (await state()).slides[1].id;
  await dragSlide(1, null);
  await until(id => window.deck.slides.at(-1)?.id === id, moved, 3000)
    .catch(async () => { const order = (await state()).slides.map(x => x.id); throw Error(`A slide dropped below the list must go to the end: it is at ${order.indexOf(moved) + 1} of ${order.length}.`); });
  await dragSlide(exampleSlides - 1, 1);
  await until(id => window.deck.slides[1]?.id === id, moved, 3000);
  const batches = await requests('records.batch');
  assert(batches.length >= 3 && batches.slice(-3).every(b => b.offerUndo === true && typeof b.label === 'string'), 'Add, move and delete must each be a labelled batch that offers Undo.');
  checks.push('add, move, delete');

  // 6. A picture dropped on the stage goes into the slide's picture field in the same revision.
  await frame.evaluate(() => document.querySelectorAll('#slides li')[window.deck.slides.findIndex(s => s.layout === 'Image right')].click());
  const pictureSlide = (await state()).slideId;
  await frame.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 40 });
    canvas.getContext('2d').fillRect(0, 0, 64, 40);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const data = new DataTransfer(); data.items.add(new File([blob], 'square.png', { type: 'image/png' }));
    document.getElementById('stage').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await settle(1200);
  const commits = async () => (await requests('media.put')).filter(p => p.base64 === undefined);
  const pictureCommit = (await commits()).find(c => c.recordId === pictureSlide);
  assert(pictureCommit && pictureCommit.entityId === 'dk.slide' && pictureCommit.fieldId === 'dk.slide.image' && pictureCommit.mediaType === 'image/png',
    `A dropped picture must be put into dk.slide.image of the slide on the stage: ${JSON.stringify(pictureCommit)}.`);
  const pictureCommits = (await commits()).filter(c => c.recordId === pictureSlide).length;
  assert(pictureCommits === 1, `A picture dropped on the stage must be put once: ${pictureCommits} times.`);
  checks.push('picture');

  // 20. A Picture grid's places each take their own picture: one dropped on a place, chosen with
  // its button, or chosen by a click on the place goes into that place's field, and the slide keeps
  // its layout. The fixture leaves the fields as they were, so every place stays empty to drop on.
  const pictureLayout = (await state()).slides.find(x => x.id === pictureSlide).layout;
  await frame.click('#layouts [data-layout="Picture grid"]');
  await until(id => window.deck.slides.find(s => s.id === id)?.layout === 'Picture grid', pictureSlide, 4000);
  await settle(300);
  const more = await frame.evaluate(() => ({ shown: !document.querySelector('.field[data-uses="pictures"]').closest('[hidden]') && !document.querySelector('.field[data-uses="pictures"]').hidden,
    first: document.getElementById('l-image').textContent, places: [...document.querySelectorAll('#stage [data-role="image"][data-slot]')].map(e => e.dataset.slot) }));
  assert(more.shown && more.first === 'Picture 1' && more.places[0] === '0' && more.places.includes('1'), `A Picture grid must offer its other pictures and draw a place for each, from the first: ${JSON.stringify(more)}.`);
  const before = (await commits()).filter(c => c.recordId === pictureSlide).length;
  await frame.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 40 });
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const data = new DataTransfer(); data.items.add(new File([blob], 'second.png', { type: 'image/png' }));
    document.querySelector('#stage [data-role="image"][data-slot="1"]').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await settle(900);
  // A real file chooser is a modal the lane's runner stops at, and it has no Node Buffer to answer
  // one: the file input's own click is held, counted, and answered in the frame as a chooser would.
  await frame.evaluate(() => { const input = document.getElementById('image-file'); window.choosers = 0; input.click = () => { window.choosers++; }; });
  const choose = async (open, name) => {
    const opened = await frame.evaluate(() => window.choosers);
    await open();
    await until(n => window.choosers > n, opened, 3000).catch(() => { throw Error(`Choosing picture ${name} must open the file chooser.`); });
    await frame.evaluate(async name => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 40 });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const data = new DataTransfer(); data.items.add(new File([blob], name, { type: 'image/png' }));
      const input = document.getElementById('image-file');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, name);
    await settle(900);
  };
  await choose(() => frame.click('#pick-image4'), 'fourth.png');
  await choose(() => frame.click('#stage [data-role="image"][data-slot="1"]'), 'again.png');
  await frame.evaluate(() => { delete document.getElementById('image-file').click; });
  const gridPuts = (await commits()).filter(c => c.recordId === pictureSlide).slice(before).map(c => `${c.fieldId} ${c.name}`);
  assert(JSON.stringify(gridPuts) === JSON.stringify(['dk.slide.image2 second.png', 'dk.slide.image4 fourth.png', 'dk.slide.image2 again.png']),
    `Each picture must go into the place it was dropped on or chosen for: ${JSON.stringify(gridPuts)}.`);
  assert((await record('dk.slide', pictureSlide)).values['dk.slide.layout'] === 'Picture grid', 'A picture put into a grid must leave the slide a Picture grid.');
  // The slide goes back to its own layout, which the exports below look for.
  await frame.click(`#layouts [data-layout="${pictureLayout}"]`);
  await until(([id, layout]) => window.deck.slides.find(s => s.id === id)?.layout === layout, [pictureSlide, pictureLayout], 4000);
  checks.push('picture grid');

  // 7. A Claude Design bundle from Brandkits dropped on the Design tab becomes a brand kit the deck uses.
  await frame.click('#tab-design');
  await frame.evaluate(async () => {
    const { zip } = await import('./zip.mjs');
    const enc = s => new TextEncoder().encode(s);
    const tokens = { name: 'Northwind', color: { brand: { primary: { $value: '#0B6E4F' }, secondary: { $value: '#F2A541' }, accent: { $value: '#E4572E' } },
      neutral: { background: { $value: '#FFFDF8' }, text: { $value: '#1D2A26' }, 'text-secondary': { $value: '#5E6B66' } } },
      font: { family: { heading: { $value: 'Fraunces, serif', $type: 'fontFamily' }, body: { $value: 'Inter, sans-serif', $type: 'fontFamily' } } } };
    const logo = fill => enc(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><rect width="200" height="50" fill="${fill}"/></svg>`);
    const bytes = zip([
      { name: 'northwind/README.md', data: enc('# Northwind brand kit\n\nTagline: Goods that travel well\n\n## Voice\n\nWarm, plain and direct.\n') },
      { name: 'northwind/tokens/tokens.json', data: enc(JSON.stringify(tokens)) },
      { name: 'northwind/assets/logos/logo-primary.svg', data: logo('#0B6E4F') },
      { name: 'northwind/assets/logos/logo-reverse.svg', data: logo('#FFFFFF') },
    ]);
    const data = new DataTransfer(); data.items.add(new File([bytes], 'northwind.zip', { type: 'application/zip' }));
    document.getElementById('inspector').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await until(() => window.deck.brands.length === 1 && window.deck.theme.brand?.name === 'Northwind', null, 8000);
  const [kit] = await records('dk.brand');
  const want = { 'dk.brand.name': 'Northwind', 'dk.brand.primary': '#0B6E4F', 'dk.brand.accent': '#E4572E', 'dk.brand.ink': '#1D2A26', 'dk.brand.muted': '#5E6B66',
    'dk.brand.headingFont': 'Fraunces', 'dk.brand.bodyFont': 'Inter', 'dk.brand.tagline': 'Goods that travel well', 'dk.brand.voice': 'Warm, plain and direct.', 'dk.brand.source': 'Brandkits' };
  const wrong = Object.entries(want).filter(([k, v]) => kit.values[k] !== v);
  assert(wrong.length === 0, `The kit must carry the bundle's roles, fonts, tagline and voice: ${JSON.stringify(wrong.map(([k]) => [k, kit.values[k]]))}.`);
  const logos = (await commits()).filter(c => c.recordId === kit.recordId).map(c => `${c.fieldId} ${c.name}`).sort();
  assert(JSON.stringify(logos) === JSON.stringify(['dk.brand.logo logo-primary.svg', 'dk.brand.logoDark logo-reverse.svg']), `The bundle's two logos must go into Logo and Logo on dark: ${JSON.stringify(logos)}.`);
  const deckRecord = (await records('dk.deck'))[0];
  assert(deckRecord.values['dk.deck.brand'] === kit.recordId, 'The deck on screen must use the kit it imported.');
  // A brand's primary is read on the slide: the resolved primary text must hold 3:1 on the background.
  const contrast = await frame.evaluate(async () => {
    const { contrast } = await import('./themes.mjs');
    const c = window.deck.theme.colors;
    return { primaryText: contrast(c.primaryText, c.bg), ink: contrast(c.ink, c.bg), muted: contrast(c.muted, c.bg) };
  });
  assert(contrast.primaryText >= 3 && contrast.ink >= 7 && contrast.muted >= 4.5, `The brand's colours must stay legible on the template: ${JSON.stringify(contrast)}.`);
  // The same kit again from a file that holds one colour changes that colour and keeps the rest.
  await frame.evaluate(() => {
    const tokens = { name: 'Northwind', color: { brand: { primary: { $value: '#0A5C42' } } } };
    const data = new DataTransfer(); data.items.add(new File([JSON.stringify(tokens)], 'tokens.json', { type: 'application/json' }));
    document.getElementById('inspector').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(id => window.broker.record('dk.brand', id)?.values['dk.brand.primary'] === '#0A5C42', kit.recordId, { timeout: 8000 });
  const again = await record('dk.brand', kit.recordId);
  const lost = ['dk.brand.accent', 'dk.brand.ink', 'dk.brand.headingFont', 'dk.brand.tagline', 'dk.brand.voice'].filter(k => again.values[k] !== want[k]);
  assert(lost.length === 0 && (await records('dk.brand')).length === 1, `An import again must keep what its file does not hold: ${JSON.stringify(lost.map(k => [k, again.values[k]]))}.`);
  checks.push('brand kit import');

  // 7b. A Deck design from Brandkits becomes a Design (a Template naming its Brand kit) the deck uses,
  // with its backgrounds, mark, chart colours and logo place; a second import updates it in place.
  const footerBefore = (await records('dk.deck'))[0].values['dk.deck.footer'];
  const dropDesign = primary => frame.evaluate(async primary => {
    const { writeDesignPackage } = await import('./design.mjs');
    const svg = fill => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><rect width="200" height="50" fill="${fill}"/></svg>`;
    const design = { format: 'nendo.deck-design', version: 1, name: 'Aurora Test', tagline: 'Made for the long night.', source: { app: 'Brandkits', kit: 'k-aurora' },
      template: { family: 'studio', mode: 'dark', style: { radius: 4, kicker: 'caps' } },
      colors: { primary, secondary: '#14324A', accent: '#7CF2B0', background: '#0B1622', surface: '#13222F', ink: '#EAF2F7', muted: '#93A7B6' },
      chart: ['#E8C26A', '#C0392B'], fonts: { heading: 'Space Grotesk', body: 'Inter' },
      logos: { light: 'logos/logo.svg', dark: 'logos/logo-dark.svg', mark: 'logos/mark.svg', placement: 'bottom-left' },
      backgrounds: { title: { kind: 'gradient', stops: ['primary', 'background'] }, section: { kind: 'image', src: 'backgrounds/section.svg', tint: 'background', tintAlpha: 0.4, dark: true } },
      deck: { footer: 'Aurora footer', slideNumbers: true } };
    const pictures = new Map([['logos/logo.svg', svg('#2F6F8F')], ['logos/logo-dark.svg', svg('#FFFFFF')], ['logos/mark.svg', svg('#7CF2B0')], ['backgrounds/section.svg', svg('#0B1622')]]);
    const data = new DataTransfer(); data.items.add(new File([writeDesignPackage(design, pictures)], 'Aurora Test.deckdesign', { type: 'application/zip' }));
    document.getElementById('inspector').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, primary);
  await dropDesign('#2F6F8F');
  // The import is a batch, a read and a put per picture, a reread and the deck's write, one after
  // another: on a slow run that is more than eight seconds, so it gets the export's fifteen, and a
  // timeout says how far it got.
  await until(() => window.deck.theme.name === 'Aurora Test' && window.deck.theme.backgrounds.title?.fill?.type === 'linear', null, 15000).catch(async () => {
    const at = await frame.evaluate(() => ({ theme: window.deck.theme?.name, problem: String(window.deck.problem?.message ?? window.deck.problem ?? ''), toast: document.querySelector('.toast, #toast')?.textContent ?? '' }));
    const puts = await page.evaluate(() => window.broker.requests.filter(r => r.m === 'media.put' && r.p.base64 === undefined).length);
    throw Error(`A dropped .deckdesign must become the deck's design: ${JSON.stringify({ ...at, mediaPuts: puts })}.`);
  });
  await page.waitForFunction(() => window.broker.requests.filter(r => r.m === 'media.put' && r.p.base64 === undefined).length >= 6, null, { timeout: 8000 });
  const designTemplate = (await records('dk.template')).find(t => t.values['dk.template.source'] === 'Brandkits:k-aurora');
  const designKit = (await records('dk.brand')).find(b => b.values['dk.brand.name'] === 'Aurora Test');
  assert(designTemplate && designKit && designTemplate.values['dk.template.brand'] === designKit.recordId, 'A design must land as a Template that names its Brand kit.');
  const onDeck = (await records('dk.deck'))[0].values;
  assert(onDeck['dk.deck.template'] === designTemplate.recordId && onDeck['dk.deck.brand'] === designKit.recordId, 'The deck on screen must use the design it imported.');
  assert(onDeck['dk.deck.footer'] === footerBefore, 'A design\'s footer must not replace the footer the deck has.');
  const designPictures = (await commits()).filter(c => c.recordId === designKit.recordId || c.recordId === designTemplate.recordId).map(c => `${c.fieldId} ${c.name}`).sort();
  assert(JSON.stringify(designPictures) === JSON.stringify(['dk.brand.logo logo.svg', 'dk.brand.logoDark logo-dark.svg', 'dk.brand.mark mark.svg', 'dk.template.sectionImage section.svg']),
    `A design's logos, mark and background picture must go into their media fields: ${JSON.stringify(designPictures)}.`);
  // The fixture answers a media put with its address and leaves the field as it was, where Nendo
  // sets it; the records are read here with the addresses the puts answered, as Nendo would hold them.
  const addressOf = async (recordId, fieldId) => {
    const at = (await commits()).findIndex(c => c.recordId === recordId && c.fieldId === fieldId);
    return (await page.evaluate(() => window.broker.mediaPuts))[at]?.address;
  };
  const held = { template: { ...designTemplate.values, 'dk.template.sectionImage': await addressOf(designTemplate.recordId, 'dk.template.sectionImage') },
    kit: { ...designKit.values, 'dk.brand.logo': await addressOf(designKit.recordId, 'dk.brand.logo'), 'dk.brand.mark': await addressOf(designKit.recordId, 'dk.brand.mark') } };
  const drawn = await frame.evaluate(async held => {
    const { layoutSlide } = await import('./layout.mjs');
    const { templateSpecFrom, brandSpecFrom } = await import('./design.mjs');
    const { resolveTheme } = await import('./themes.mjs');
    const t = resolveTheme(templateSpecFrom(held.template), brandSpecFrom(held.kit), { aspect: '16:9', footer: 'Footer' });
    const section = layoutSlide({ layout: 'Section', title: 'Two', kicker: '02', body: '' }, t);
    const chart = layoutSlide({ layout: 'Chart', title: 'Sales', kicker: '', body: '| Q | A |\n| --- | --- |\n| 1 | 3 |\n| 2 | 5 |', body2: '', chart: 'Column' }, t, { number: 3 });
    const logo = chart.items.find(i => i.role === 'logo');
    return { first: section.items[0].role, dark: section.dark, bg: t.colors.bg, family: t.family, bars: chart.items.some(i => i.fill === '#E8C26A'), logo: logo && { src: logo.src === t.brand.mark, left: logo.x < 200, low: logo.y > 600 },
      designs: document.querySelectorAll('#designs button').length, chosen: document.querySelector('#designs button')?.getAttribute('aria-selected'), templates: document.querySelectorAll('#templates button').length };
  }, held);
  assert(drawn.first === 'background' && drawn.dark && drawn.bg === '#0B1622' && drawn.family === 'studio' && drawn.bars && drawn.logo?.src && drawn.logo.left && drawn.logo.low,
    `The design must draw its section picture, dark stage, chart colours and the mark at the bottom left: ${JSON.stringify(drawn)}.`);
  assert(drawn.designs === 1 && drawn.chosen === 'true' && drawn.templates === 6, `The design must show once, chosen, under Designs and not among the six templates: ${JSON.stringify(drawn)}.`);
  // The Slide tab's layout gallery was drawn in the old look; it is drawn again in the design's.
  await frame.click('#tab-slide');
  const gallery = await frame.evaluate(async () => {
    const { layoutSlide } = await import('./layout.mjs');
    const { slideHtml } = await import('./render.mjs');
    const want = document.createElement('div');
    want.innerHTML = slideHtml(layoutSlide({ layout: 'Bullets', title: 'Title', kicker: '', body: '- Point' }, window.deck.theme));
    return { want: want.firstElementChild.style.background, got: document.querySelector('#layouts [data-layout="Bullets"] .dk-slide')?.style.background };
  });
  assert(gallery.got && gallery.got === gallery.want, `The layout gallery must be drawn in the design the deck now uses: ${JSON.stringify(gallery)}.`);
  await frame.click('#tab-design');
  await dropDesign('#3A86A8');
  await page.waitForFunction(id => window.broker.record('dk.brand', id)?.values['dk.brand.primary'] === '#3A86A8', designKit.recordId, { timeout: 8000 });
  // The import ends by putting the design on the deck, after its pictures: a template or kit chosen
  // before then is put back by it, so the checks go on once the import says it is done.
  await until(() => /updated in place/.test(document.getElementById('toast').textContent), null, 15000)
    .catch(() => { throw Error('A design imported again must say it was updated in place.'); });
  const counts = [(await records('dk.template')).length, (await records('dk.brand')).length];
  assert(counts[0] === 7 && counts[1] === 2, `A design imported again must update its two records in place: ${JSON.stringify(counts)} templates and kits.`);
  // Back to the template and kit the checks below were written for.
  await frame.click('#templates [data-template="dk.template.keynote"]');
  await frame.click(`#brands [data-brand="${kit.recordId}"]`);
  await until(id => window.deck.theme.name === 'Keynote' && window.deck.theme.brand?.name === 'Northwind', null, 8000);
  checks.push('design import');

  // 8. An ask is a record first, then a message that names the skill, with the ask and deck as context.
  await frame.click('#tab-slide');
  await frame.evaluate(() => document.querySelectorAll('#slides li')[4].click());
  const askSlide = (await state()).slideId;
  await frame.click('[data-scope="Selection"]');
  await frame.fill('#ask-text', 'Make this punchier');
  await frame.click('#ask-send');
  await until(() => document.getElementById('ask-status').classList.contains('working'));
  await page.waitForFunction(() => window.broker.assistantAsks.length === 1, null, { timeout: 5000 });
  const [ask] = await records('dk.ask');
  assert(ask && ask.values['dk.ask.status'] === 'Waiting' && ask.values['dk.ask.scope'] === 'Selection' && ask.values['dk.ask.selection'].startsWith(askSlide),
    `The ask must be written, Waiting, for the selected slide: ${JSON.stringify(ask?.values)}.`);
  const order = await page.evaluate(() => window.broker.requests.map(r => r.m).filter(m => m === 'records.create' || m === 'assistant.ask'));
  assert(order.lastIndexOf('records.create') < order.lastIndexOf('assistant.ask'), 'The Ask record must be written before the agent is messaged.');
  const [message] = (await requests('assistant.ask')).slice(-1);
  assert(message.text.includes('skill://dev.nendo.deck/deck/SKILL.md') && message.text.includes(ask.recordId), 'The message must name the skill and the ask.');
  const uris = message.context.map(c => c.uri);
  assert(uris.includes(`nendo://application/entity/dk.ask/records?recordId=${ask.recordId}`) && uris.includes(`nendo://application/entity/dk.deck/records?recordId=${deckRecord.recordId}`)
    && uris.includes(`nendo://application/entity/dk.slide/records?recordId=${askSlide}`), `The context must point at the ask, the deck and the slide: ${JSON.stringify(uris)}.`);
  checks.push('ask');

  // 9. The agent's variants show under the stage; Use puts one on the slide and dismisses its siblings.
  await page.evaluate(({ askId, slideId }) => {
    const variant = (n, label, changes) => window.broker.put('dk.variant', { entityId: 'dk.variant', recordId: `dk.variant.v${n}`, version: 1, labels: {}, exact: {}, calculated: {},
      values: { 'dk.variant.ask': askId, 'dk.variant.slide': slideId, 'dk.variant.label': label, 'dk.variant.changes': JSON.stringify(changes), 'dk.variant.rationale': 'Shorter.', 'dk.variant.status': 'Proposed' } });
    variant(1, 'Three short lines', { title: 'Short lines win', body: '- Say the point\n- Then stop' });
    variant(2, 'As a statement', { layout: 'Statement', title: 'If it needs a paragraph, it belongs in the notes.', 'dk.slide.kicker': 'The rule', image: 'media:not-allowed' });
    const a = window.broker.records('dk.ask')[0];
    window.broker.put('dk.ask', { ...a, version: a.version + 1, values: { ...a.values, 'dk.ask.status': 'Done', 'dk.ask.reply': 'Two variants.' } });
    window.broker.pushChanges();
    window.broker.answerAssistant({ reply: 'Two variants are on the slide.', stopReason: 'end_turn' });
  }, { askId: ask.recordId, slideId: askSlide });
  await until(() => document.querySelectorAll('#variants .variant').length === 2);
  assert(await frame.locator(`#slides li[data-id="${askSlide}"].has-variants`).count() === 1, 'The slide in the list must say it has variants.');
  // A Use the file refuses, after a save it refused too, keeps the typing in the fields the variant sets.
  await frame.fill('#f-title', 'Typed before a refused Use');
  await page.evaluate(() => { window.broker.fail('records.update', { code: 'busy', message: 'The file is busy.' }); window.broker.fail('records.batch', { code: 'busy', message: 'The file is busy.' }); });
  await frame.evaluate(() => document.querySelector('#variants [data-use="dk.variant.v2"]').click());
  await settle(1200);
  const keptForUse = await frame.evaluate(id => window.deck.pending.get(id)?.values.title, askSlide);
  assert(keptForUse === 'Typed before a refused Use', `A refused Use must keep the typing it would have replaced: ${JSON.stringify(keptForUse)}.`);
  // Typing in the pause before its save, then Use from the keyboard, which takes no focus away.
  await frame.fill('#notes', 'Typed before Use');
  await frame.evaluate(() => document.querySelector('#variants [data-use="dk.variant.v2"]').click());
  await until(() => document.querySelectorAll('#variants .variant').length === 0);
  await settle(900);
  const used = await record('dk.slide', askSlide);
  assert(used.values['dk.slide.layout'] === 'Statement' && used.values['dk.slide.kicker'] === 'The rule' && !used.values['dk.slide.image'],
    `Use must set the variant's slide fields, and only slide fields it may: ${JSON.stringify(used.values)}.`);
  assert(used.values['dk.slide.notes'] === 'Typed before Use', `Use must keep the typing it does not change: notes ${JSON.stringify(used.values['dk.slide.notes'])}.`);
  assert((await record('dk.variant', 'dk.variant.v2')).values['dk.variant.status'] === 'Used' && (await record('dk.variant', 'dk.variant.v1')).values['dk.variant.status'] === 'Dismissed',
    'The used variant is Used and its sibling Dismissed.');
  assert(!await frame.evaluate(() => document.getElementById('ask-status').classList.contains('working')), 'The ask bar stops showing work once the agent answers.');
  // A turn cut short leaves its ask Failed, not Done: it may have written half the slides.
  await frame.click('[data-scope="Whole deck"]');
  await frame.fill('#ask-text', 'Tighten every title');
  await frame.click('#ask-send');
  await page.waitForFunction(() => window.broker.assistantAsks.length === 2, null, { timeout: 5000 });
  await page.evaluate(() => window.broker.answerAssistant({ reply: '', stopReason: 'max_tokens' }));
  await until(() => !document.getElementById('ask-status').classList.contains('working'));
  const cut = (await records('dk.ask')).find(a => a.values['dk.ask.request'] === 'Tighten every title');
  assert(cut?.values['dk.ask.status'] === 'Failed', `An ask whose turn ran out must be Failed, not Done: ${cut?.values['dk.ask.status']}.`);
  checks.push('variants');

  // 10. The three exports: a PowerPoint package with every slide and its notes, one HTML file that
  // needs nothing else, and the notes as Markdown.
  const exported = async (id, name) => {
    const before = await frame.evaluate(() => window.deck.exports.length);
    await command(id);
    await until(n => window.deck.exports.length > n, before, 15000);
    return frame.evaluate(async name => {
      const blob = window.deck.lastExport;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (name !== 'pptx') return { name: window.deck.exports.at(-1).name, text: new TextDecoder().decode(bytes) };
      const { unzip } = await import('./zip.mjs');
      const entries = unzip(bytes);
      const presentation = new TextDecoder().decode(await entries.find(e => e.name === 'ppt/presentation.xml').bytes());
      const notes = (await Promise.all(entries.filter(e => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.name)).map(async e => new TextDecoder().decode(await e.bytes())))).join('\n');
      return { name: window.deck.exports.at(-1).name, magic: bytes[0] === 0x50 && bytes[1] === 0x4b, names: entries.map(e => e.name), size: /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(presentation)?.slice(1), notes };
    }, name);
  };
  // Notes changed after the thumbnails were drawn go into the PowerPoint file as they are now.
  await frame.fill('#notes', 'Notes typed after the thumbnails');
  await settle(1200);
  const pptx = await exported('export.pptx', 'pptx');
  assert(pptx.notes.includes('Notes typed after the thumbnails'), 'The PowerPoint file must carry the notes as they are now, not as they were when the slide was last drawn.');
  const slideParts = pptx.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  const noteParts = pptx.names.filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length;
  assert(pptx.magic && pptx.name.endsWith('.pptx') && slideParts === exampleSlides && noteParts === exampleSlides && pptx.names.includes('[Content_Types].xml')
    && JSON.stringify(pptx.size) === JSON.stringify(['12192000', '6858000']), `The PowerPoint file must hold ${exampleSlides} slides with notes at 16:9: ${JSON.stringify({ slideParts, noteParts, size: pptx.size })}.`);
  await page.evaluate(deckId => {
    const slides = window.broker.records('dk.slide').filter(r => r.values['dk.slide.deck'] === deckId);
    const set = (layout, address) => { const s = slides.find(r => r.values['dk.slide.layout'] === layout); window.broker.put('dk.slide', { ...s, version: s.version + 1, values: { ...s.values, 'dk.slide.image': address } }); };
    set('Full image', 'https://example.com/pictures/harbour.png');
    set('Image right', '.\\Deck pictures\\gone.png');
    window.broker.pushChanges();
  }, deckRecord.recordId);
  await until(() => window.deck.slides.some(s => s.image === 'https://example.com/pictures/harbour.png'));
  // The deck's own typing goes into the export made in the pause before its save.
  await frame.click('#tab-design');
  await frame.fill('#d-title', 'Typed just before export');
  const html = await exported('export.html', 'html');
  assert(html.text.includes('<title>Typed just before export</title>') && html.name === 'Typed just before export.html',
    `An export made in the pause must carry the deck's typing: ${JSON.stringify({ name: html.name, title: /<title>([^<]*)/.exec(html.text)?.[1] })}.`);
  // The file opened at #2 shows slide 2, and only it. A click in its audience window turns the talk
  // in the console that drives it, so the two never part.
  const fileUrl = await page.evaluate(text => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/html' }));
    const file = Object.assign(document.createElement('iframe'), { name: 'hashcheck', src: url + '#2' });
    file.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:800px';
    document.body.append(file);
    return url;
  }, html.text);
  await page.waitForFunction(() => !!document.querySelector('iframe[name="hashcheck"]')?.contentWindow?.deckPlayer, null, { timeout: 5000 })
    .catch(() => { throw Error('The exported file did not open at #2.'); });
  const talkState = () => page.evaluate(() => document.querySelector('iframe[name="hashcheck"]').contentWindow.deckPlayer.state());
  const atTwo = await page.evaluate(() => {
    const doc = document.querySelector('iframe[name="hashcheck"]').contentDocument;
    return { at: doc.defaultView.deckPlayer.state().at, inView: [...doc.querySelectorAll('#frame > .dk-slide')].flatMap((s, i) => s.classList.contains('off') ? [] : [i]) };
  });
  assert(atTwo.at === 1 && atTwo.inView.length === 1 && atTwo.inView[0] === 1, `The file opened at #2 must show slide 2 and only it: ${JSON.stringify(atTwo)}.`);
  const [audienceWindow] = await Promise.all([page.context().waitForEvent('page', { timeout: 5000 }),
    page.evaluate(() => document.querySelector('iframe[name="hashcheck"]').contentDocument.getElementById('c-audience').click())]);
  await audienceWindow.waitForFunction(() => !!window.deckPlayer, null, { timeout: 5000 });
  // As soon as its player is ready the audience window is where the talk is, not after a guessed delay.
  const synced = await audienceWindow.waitForFunction(() => window.deckPlayer.state().at === 1, null, { timeout: 150 }).then(() => true, () => false);
  assert(synced, `The audience window must take the talk's place as soon as its player is ready: ${JSON.stringify(await audienceWindow.evaluate(() => window.deckPlayer.state().at))}.`);
  const talkBefore = await talkState();
  const audienceBox = await audienceWindow.locator('#frame').boundingBox();
  await audienceWindow.mouse.click(audienceBox.x + audienceBox.width * 0.75, audienceBox.y + audienceBox.height / 2);
  await page.waitForFunction(b => { const s = document.querySelector('iframe[name="hashcheck"]').contentWindow.deckPlayer.state(); return s.at * 1000 + s.shown > b.at * 1000 + b.shown; }, talkBefore, { timeout: 3000 }).catch(() => {});
  await settle(300);
  const talkAfter = await talkState(), audienceAfter = await audienceWindow.evaluate(() => window.deckPlayer.state());
  assert(talkAfter.at * 1000 + talkAfter.shown > talkBefore.at * 1000 + talkBefore.shown && audienceAfter.at === talkAfter.at && audienceAfter.shown === talkAfter.shown,
    `A click in the audience window must turn the talk in the console, and both must show the same place: ${JSON.stringify({ talkBefore, talkAfter, audienceAfter })}.`);
  // F in the audience window fills that window, not the console's.
  const fullCount = 'window.fullAsked = 0; document.documentElement.requestFullscreen = () => { window.fullAsked++; return Promise.resolve(); };';
  await audienceWindow.evaluate(fullCount);
  await page.evaluate(code => document.querySelector('iframe[name="hashcheck"]').contentWindow.eval(code), fullCount);
  await audienceWindow.locator('body').press('f');
  await settle(300);
  const fullAsked = { audience: await audienceWindow.evaluate(() => window.fullAsked), console: await page.evaluate(() => document.querySelector('iframe[name="hashcheck"]').contentWindow.fullAsked) };
  assert(fullAsked.audience === 1 && fullAsked.console === 0, `F in the audience window must ask that window, and only it, for full screen: ${JSON.stringify(fullAsked)}.`);
  await audienceWindow.close();
  await page.evaluate(url => { document.querySelector('iframe[name="hashcheck"]').remove(); URL.revokeObjectURL(url); }, fileUrl);
  // Printing the file from presenter view prints the slides.
  await page.evaluate(text => {
    const sheet = Object.assign(document.createElement('iframe'), { name: 'printcheck', srcdoc: text });
    sheet.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px';
    document.body.append(sheet);
  }, html.text);
  // The file's own stylesheet is what is measured: presenter view is its body class, set here directly.
  await page.waitForFunction(() => !!document.querySelector('iframe[name="printcheck"]')?.contentDocument?.getElementById('count')?.textContent, null, { timeout: 5000 })
    .catch(() => { throw Error('The exported file did not open.'); });
  // Enter on a focused player button is that button's, not the next slide's.
  const pressed = await page.evaluate(() => {
    const doc = document.querySelector('iframe[name="printcheck"]').contentDocument;
    doc.getElementById('next').click();
    const before = doc.getElementById('count').textContent;
    const prev = doc.getElementById('prev');
    prev.focus();
    prev.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return { before, after: doc.getElementById('count').textContent };
  });
  assert(pressed.before === pressed.after, `Enter on a focused player button must not turn the slide: ${pressed.before} became ${pressed.after}.`);
  await page.evaluate(() => document.querySelector('iframe[name="printcheck"]').contentDocument.body.classList.add('presenter'));
  await page.emulateMedia({ media: 'print' });
  const shown = await page.evaluate(() => { const doc = document.querySelector('iframe[name="printcheck"]').contentDocument; return { presenter: doc.body.classList.contains('presenter'), deck: doc.defaultView.getComputedStyle(doc.getElementById('deck')).display }; });
  await page.emulateMedia({ media: null });
  await page.evaluate(() => document.querySelector('iframe[name="printcheck"]').remove());
  assert(shown.presenter && shown.deck !== 'none', `Printing from presenter view must print the slides: ${JSON.stringify(shown)}.`);
  // An export made while the deck's write is out waits for its answer.
  await page.evaluate(() => window.broker.hold('records.update', 1500));
  await frame.fill('#d-title', 'Typed while its save is out');
  await settle(900);
  const late = await exported('export.html', 'html');
  assert(late.name === 'Typed while its save is out.html', `An export made while the deck's write is out must wait for it: ${JSON.stringify(late.name)}.`);
  await frame.fill('#d-title', 'Typed just before export');
  await page.waitForFunction(id => window.broker.record('dk.deck', id)?.values['dk.deck.title'] === 'Typed just before export', deckRecord.recordId, { timeout: 5000 });
  await frame.click('#tab-slide');
  const leftOut = await frame.evaluate(() => window.deck.exports.at(-1).leftOut);
  assert(html.text.includes('https://example.com/pictures/harbour.png') && leftOut === 1,
    `The HTML file must link a web picture it cannot read and count one from a folder as left out: linked ${html.text.includes('https://example.com/pictures/harbour.png')}, left out ${leftOut}.`);
  const htmlSlides = (html.text.match(/class="dk-slide/g) ?? []).length;
  assert(html.name.endsWith('.html') && htmlSlides === exampleSlides && !/<script[^>]+src=/i.test(html.text) && !/<link[^>]+stylesheet[^>]+href="(?!https:\/\/fonts\.googleapis\.com)/i.test(html.text),
    `The HTML file must hold every slide and load no script or stylesheet of its own from elsewhere: ${htmlSlides} slides.`);
  // The notes file, too, carries the deck's typing from the pause before its save.
  await frame.click('#tab-design');
  await frame.fill('#d-title', 'Typed before the notes');
  const notes = await exported('export.notes', 'md');
  assert(notes.name.endsWith('notes.md') && (notes.text.match(/^## /gm) ?? []).length === exampleSlides, 'The notes file must have one section per shown slide.');
  assert(notes.text.startsWith('# Typed before the notes') && notes.name === 'Typed before the notes - notes.md',
    `The notes file must carry the deck's typing: ${JSON.stringify({ name: notes.name, head: notes.text.split('\n')[0] })}.`);
  await frame.fill('#d-title', 'Typed just before export');
  await page.waitForFunction(id => window.broker.record('dk.deck', id)?.values['dk.deck.title'] === 'Typed just before export', deckRecord.recordId, { timeout: 5000 });
  await frame.click('#tab-slide');
  checks.push('exports');

  // 11. Present plays the same deck in a frame and Escape hands back the slide it reached.
  await command('present.here');
  await frame.waitForFunction(() => window.deck.presenting === true && !document.getElementById('present').hidden);
  const player = frame.childFrames()[0];
  await player.waitForFunction(() => document.querySelectorAll('.dk-slide').length > 0, null, { timeout: 5000 });
  await player.locator('body').press('ArrowRight');
  await player.locator('body').press('Escape');
  await frame.waitForFunction(() => window.deck.presenting === false);
  s = await state();
  assert(s.slides.findIndex(x => x.id === s.slideId) === 5, `Escape must bring the person back on the slide they presented to: ${s.slides.findIndex(x => x.id === s.slideId)}.`);
  checks.push('present');

  // 19. Presenting: a slide's points come one click at a time, with the slide's own transition and
  // the deck's, in Present and in PowerPoint; the console shows the slide in its shape, the next
  // point, the notes and the pace against the talk's length; the laser follows the pointer; a
  // rehearsal's times are kept as one step; and the Check tab sends the person to a slide.
  const newestBatch = async () => (await requests('records.batch')).at(-1);
  const cardsId = (await state()).slides.find(x => x.layout === 'Cards')?.id;
  assert(cardsId, `A Cards slide to build: ${JSON.stringify((await state()).slides.map(x => x.layout))}.`);
  await frame.locator(`#slides li[data-id="${cardsId}"]`).click();
  await frame.click('#tab-slide');
  await frame.locator('#f-build button', { hasText: 'One by one' }).click();
  await until(id => window.deck.slides.find(s => s.id === id)?.build === 'One by one' && !!document.querySelector('#stage .step-mark'), cardsId);
  let built = await record('dk.slide', cardsId);
  assert(built.values['dk.slide.build'] === 'One by one' && (await newestBatch()).label === 'Points one by one' && (await newestBatch()).offerUndo === true,
    `One by one must be written to the slide as one step Nendo offers to undo: ${JSON.stringify({ build: built.values['dk.slide.build'], label: (await newestBatch()).label })}.`);
  const marks = await frame.evaluate(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const steps = [...new Set([...document.querySelectorAll('#stage [data-step]')].map(el => el.dataset.step))];
    const shown = [...document.querySelectorAll('#stage .step-mark')].map(m => { const r = m.getBoundingClientRect(); return { k: m.textContent, inside: r.left >= stage.left - 1 && r.right <= stage.right + 1 && r.top >= stage.top - 1 }; });
    return { steps, shown };
  });
  assert(marks.steps.length >= 2 && marks.shown.length === marks.steps.length && marks.shown.every((m, i) => m.k === marks.steps[i] && m.inside),
    `The stage must mark each click's first point with its number, inside the slide: ${JSON.stringify(marks)}.`);
  await frame.locator('#f-transition button', { hasText: 'Push' }).click();
  await until(id => window.deck.slides.find(s => s.id === id)?.transition === 'Push', cardsId);
  await frame.click('#tab-design');
  await frame.locator('#d-transition button', { hasText: 'Fade' }).click();
  await frame.fill('#d-minutes', '5');
  await frame.locator('#d-minutes').press('Tab');
  await page.waitForFunction(id => window.broker.record('dk.deck', id)?.values['dk.deck.minutes'] === 5 && window.broker.record('dk.deck', id)?.values['dk.deck.transition'] === 'Fade', deckRecord.recordId, { timeout: 5000 })
    .catch(() => { throw Error('The deck\'s transition and talk length must be written to the deck: Fade and 5 minutes.'); });
  await frame.click('#tab-slide');
  await settle(400);

  // Present from the built slide: a click brings the first point, and what comes later stays hidden.
  await command('present.here');
  await frame.waitForFunction(() => window.deck.presenting === true);
  let show = frame.childFrames()[0];
  await show.waitForFunction(() => !!window.deckPlayer, null, { timeout: 5000 });
  const opacities = () => show.evaluate(() => {
    const slide = [...document.querySelectorAll('#frame > .dk-slide')].find(s => !s.classList.contains('off'));
    return [...slide.querySelectorAll('[data-step]')].map(el => ({ k: Number(el.dataset.step), o: Number(getComputedStyle(el).opacity) }));
  });
  const played = await show.evaluate(() => JSON.parse(document.getElementById('data').textContent));
  const shownAt = await show.evaluate(() => window.deckPlayer.state().at);
  assert(played.steps[shownAt] === marks.steps.length && played.transitions[shownAt] === 'Push' && played.transitions.filter((t, i) => i !== shownAt).every(t => t === 'Fade') && played.plan?.length === played.steps.length && Math.round(played.plan.reduce((a, b) => a + b, 0)) === 300,
    `Present must carry the slide's clicks, its own transition and the deck's for the rest, and a plan as long as the talk: ${JSON.stringify({ steps: played.steps[shownAt], transitions: played.transitions, plan: played.plan })}.`);
  await settle(600);
  const hiddenFirst = await opacities();
  assert(hiddenFirst.length > 0 && hiddenFirst.every(x => x.o === 0), `Before the first click no point may show: ${JSON.stringify(hiddenFirst)}.`);
  await show.locator('body').press('ArrowRight');
  await settle(700);
  const afterClick = await opacities();
  const state1 = await show.evaluate(() => window.deckPlayer.state());
  assert(state1.at === shownAt && state1.shown === 1 && afterClick.every(x => (x.k <= 1) === (x.o === 1) && (x.k > 1) === (x.o === 0)),
    `One click must bring on the first point and only it, on the same slide: ${JSON.stringify({ state: state1, afterClick })}.`);

  // The console: the slide in its own shape, the next point, the notes, the pace.
  await show.locator('body').press('p');
  await settle(300);
  const console1 = await show.evaluate(() => {
    const now = document.getElementById('now').getBoundingClientRect(), next = document.getElementById('next-box').getBoundingClientRect();
    const later = [...document.querySelectorAll('#now .thumb [data-step]')].map(el => ({ k: Number(el.dataset.step), hidden: el.classList.contains('dk-later') }));
    return { shown: getComputedStyle(document.getElementById('console')).display, ratio: now.width / now.height, nextRatio: next.width / next.height, inView: now.bottom <= innerHeight && next.bottom <= innerHeight,
      nextLabel: document.getElementById('next-label').textContent, pace: document.getElementById('pace').textContent, notes: document.getElementById('notes').textContent, later };
  });
  const wanted = 1280 / 720;
  assert(console1.shown === 'grid' && Math.abs(console1.ratio - wanted) < 0.01 && Math.abs(console1.nextRatio - wanted) < 0.01 && console1.inView,
    `The console must show this slide and the next in the slide's shape, inside the window: ${JSON.stringify(console1)}.`);
  assert(/^Next: point 2 of \d+$/.test(console1.nextLabel) && /left of 5:00$/.test(console1.pace) && console1.later.every(x => x.hidden === x.k > 1),
    `The console must name the next point, pace the talk against its five minutes, and show the slide as the audience sees it: ${JSON.stringify(console1)}.`);
  // Black from the console's button shows on the console's slide, which stands where the slides would be.
  const coverOf = () => show.evaluate(() => {
    const now = document.getElementById('now').getBoundingClientRect(), c = document.getElementById('now-cover');
    const r = c?.getBoundingClientRect();
    return { shown: !!c && getComputedStyle(c).display !== 'none', covers: !!r && Math.abs(r.width - now.width) < 1 && Math.abs(r.height - now.height) < 1,
      background: c ? getComputedStyle(c).backgroundColor : null, text: c?.textContent ?? null, pressed: document.getElementById('c-black').getAttribute('aria-pressed') };
  });
  await show.click('#c-black');
  const blacked = await coverOf();
  assert(blacked.shown && blacked.covers && /^rgba?\(0, 0, 0/.test(blacked.background) && /black screen/.test(blacked.text) && blacked.pressed === 'true',
    `Black must cover the console's slide and say the audience sees black: ${JSON.stringify(blacked)}.`);
  await show.click('#c-black');
  const unblacked = await coverOf();
  assert(!unblacked.shown && unblacked.pressed === 'false', `Black pressed again must show the slide: ${JSON.stringify(unblacked)}.`);
  // The laser follows the pointer over the console's slide, in the slide's own place.
  await show.locator('body').press('l');
  const nowBox = await show.locator('#now').boundingBox();
  await page.mouse.move(nowBox.x + nowBox.width * 0.5, nowBox.y + nowBox.height * 0.25, { steps: 3 });
  await settle(150);
  const dot = await show.evaluate(() => { const d = document.getElementById('now-laser').getBoundingClientRect(), n = document.getElementById('now').getBoundingClientRect(); return { x: (d.left + d.width / 2 - n.left) / n.width, y: (d.top + d.height / 2 - n.top) / n.height, shown: getComputedStyle(document.getElementById('now-laser')).display }; });
  assert(dot.shown === 'block' && Math.abs(dot.x - 0.5) < 0.01 && Math.abs(dot.y - 0.25) < 0.01, `The laser must stand where the pointer is on the slide: ${JSON.stringify(dot)}.`);
  // On to the next slide and straight back, inside one transition: the slide turned back to must
  // stay in view once the first transition's end has come and gone.
  const turnedBack = await show.evaluate(async () => {
    const p = window.deckPlayer, from = p.state().at;
    while (p.state().at === from) p.press('ArrowRight');
    p.press('ArrowLeft');
    await new Promise(r => setTimeout(r, 900));
    const s = p.state(), slide = document.querySelectorAll('#frame > .dk-slide')[s.at];
    return { from, at: s.at, off: slide.classList.contains('off'), others: [...document.querySelectorAll('#frame > .dk-slide')].filter(x => !x.classList.contains('off')).length };
  });
  assert(turnedBack.at === turnedBack.from && !turnedBack.off && turnedBack.others === 1,
    `A quick turn back must leave its slide, and only it, in view: ${JSON.stringify(turnedBack)}.`);
  // Escape puts the laser down, then leaves the console, then ends the show on the slide it reached.
  for (let i = 0; i < 3; i++) await show.locator('body').press('Escape');
  await frame.waitForFunction(() => window.deck.presenting === false);

  // PowerPoint: the slide's transition and its clicks.
  const deckXml = await exported('export.pptx', 'pptx');
  const builtIndex = (await state()).slides.findIndex(x => x.id === cardsId) + 1;
  const builtXml = await frame.evaluate(async n => {
    const { unzip } = await import('./zip.mjs');
    const entry = unzip(new Uint8Array(await window.deck.lastExport.arrayBuffer())).find(e => e.name === `ppt/slides/slide${n}.xml`);
    return new TextDecoder().decode(await entry.bytes());
  }, builtIndex);
  assert(deckXml.magic && /<p:transition spd="med"><p:push dir="l"\/><\/p:transition><p:timing>/.test(builtXml) && (builtXml.match(/<p:cond delay="indefinite"\/>/g) ?? []).length === marks.steps.length,
    `The PowerPoint slide must push in and bring its points on a click each: ${JSON.stringify({ push: builtXml.includes('<p:push'), clicks: (builtXml.match(/<p:cond delay="indefinite"\/>/g) ?? []).length })}.`);

  // A rehearsal: the console opens with its clock running, and Finish offers the times to keep.
  await command('present.rehearse');
  await frame.waitForFunction(() => window.deck.presenting === true);
  show = frame.childFrames()[0];
  await show.waitForFunction(() => !!window.deckPlayer && document.body.classList.contains('rehearse') && document.body.classList.contains('presenter'), null, { timeout: 5000 });
  await settle(1600);
  // Leaving the console for the slides alone and closing from their toolbar still finishes the
  // rehearsal; the console's own Finish takes the same path.
  await show.locator('body').press('p');
  await show.click('#b-close');
  await frame.waitForFunction(() => window.deck.presenting === false && !document.getElementById('rehearsed').hidden, null, { timeout: 5000 })
    .catch(() => { throw Error('Closing a rehearsal, from the console or the slides\' toolbar, must offer to keep its times.'); });
  const offer = await frame.evaluate(() => ({ text: document.getElementById('rehearsed-text').textContent, times: window.deck.timings?.times }));
  assert(/^You rehearsed for 0:0\d over 1 slide, for a 5:00 talk\./.test(offer.text) && offer.times?.length === 1 && offer.times[0].seconds >= 1,
    `The offer must say how long the rehearsal ran, over the slides it reached: ${JSON.stringify(offer)}.`);
  // A Keep the file refuses leaves the offer up, to try again.
  await page.evaluate(() => window.broker.fail('records.batch', { code: 'busy', message: 'The file is busy.' }));
  await frame.click('#rehearsed-keep');
  await settle(800);
  const refusedKeep = await frame.evaluate(() => ({ shown: !document.getElementById('rehearsed').hidden, times: window.deck.timings?.times?.length ?? 0 }));
  assert(refusedKeep.shown && refusedKeep.times === 1, `A Keep the file refuses must leave the times offered: ${JSON.stringify(refusedKeep)}.`);
  await frame.click('#rehearsed-keep');
  await page.waitForFunction(id => window.broker.record('dk.slide', id)?.values['dk.slide.seconds'] >= 1, offer.times[0].id, { timeout: 5000 })
    .catch(() => { throw Error('Keep must write the time on the slide the rehearsal spent it on.'); });
  assert((await newestBatch()).label === 'Keep the rehearsal times' && (await newestBatch()).offerUndo === true && (await newestBatch()).writes.length === 1,
    `The times must be kept as one step: ${JSON.stringify(await newestBatch())}.`);
  assert(await frame.evaluate(() => document.getElementById('rehearsed').hidden), 'The offer must close once the times are kept.');

  // The Check tab: the length against the target, and a click on a finding goes to its slide.
  await frame.click('#tab-check');
  const check = await frame.evaluate(() => ({ length: document.getElementById('check-length').textContent, items: [...document.querySelectorAll('#check-list button')].map(b => ({ id: b.dataset.slide, text: b.textContent })),
    count: document.getElementById('check-count').textContent }));
  assert(/^About \d+:\d\d for a 5:00 talk: .+\(1 of \d+ slides rehearsed, the rest from the notes\)\.$/.test(check.length) && check.items.length > 0,
    `The Check tab must weigh the talk's length against its target, from the rehearsal and the notes, and list what to look at: ${JSON.stringify(check)}.`);
  const here = (await state()).slideId;
  const target = check.items.find(x => x.id !== here) ?? check.items[0];
  await frame.locator(`#check-list button[data-slide="${target.id}"]`).first().click();
  assert((await state()).slideId === target.id, `A finding must open its slide: ${JSON.stringify({ wanted: target.id, at: (await state()).slideId })}.`);
  // Back to all points at once, as the checks below were written for.
  await frame.locator(`#slides li[data-id="${cardsId}"]`).click();
  await frame.click('#tab-slide');
  await frame.locator('#f-build button', { hasText: 'All at once' }).click();
  await until(id => window.deck.slides.find(s => s.id === id)?.build === 'None' && !document.querySelector('#stage .step-mark'), cardsId);
  checks.push('builds, transitions, console, rehearsal, check');

  // 12. The frame follows Nendo's theme, and the Ask button's text reads on its colour in both.
  const button = async () => frame.evaluate(async () => {
    const { contrast, normalHex } = await import('./themes.mjs');
    const rgb = c => { const m = c.match(/\d+/g).map(Number); return normalHex('#' + m.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('')); };
    const b = getComputedStyle(document.getElementById('ask-send'));
    return { ratio: contrast(rgb(b.color), rgb(b.backgroundColor)), body: getComputedStyle(document.body).backgroundColor };
  });
  const light = await button();
  await page.evaluate(() => window.broker.pushTheme('dark'));
  await settle(300);
  const dark = await button();
  assert(light.ratio >= 4.5 && dark.ratio >= 4.5, `The Ask button's text must hold 4.5:1 in light and dark: ${light.ratio.toFixed(2)}, ${dark.ratio.toFixed(2)}.`);
  assert(dark.body === 'rgb(39, 40, 41)', `The frame must take Nendo's dark canvas: ${dark.body}.`);
  checks.push('theme');

  // 13. Typing the frame never got to save is saved when the view starts again. A remount closes
  // the old frame's port first, so nothing it sends on the way out arrives.
  await frame.evaluate(() => document.querySelectorAll('#slides li')[2].click());
  const kept = (await state()).slideId;
  await frame.fill('#f-title', 'Kept from before');
  // The first start's write is refused: the typing stays kept, and the next start saves it.
  await page.evaluate(() => { window.broker.fail('records.update', { code: 'busy', message: 'The file is busy.' }); window.broker.remount(); });
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  assert(await frame.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('deck.drafts.')).length) === 1, 'Typing whose restore was refused must stay kept on the device.');
  await page.evaluate(() => window.broker.remount());
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  await page.waitForFunction(id => window.broker.record('dk.slide', id)?.values['dk.slide.title'] === 'Kept from before', kept, { timeout: 5000 })
    .catch(async () => { throw Error(`Typing not saved when the frame ended must be saved when the view starts again: ${JSON.stringify((await record('dk.slide', kept))?.values['dk.slide.title'])}.`); });
  assert(await frame.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('deck.drafts.')).length) === 0, 'A draft that was saved must leave the device.');
  // The deck's own fields are kept the same way.
  await frame.click('#tab-design');
  await frame.fill('#d-footer', 'Footer kept from before');
  await page.evaluate(() => window.broker.remount());
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  await page.waitForFunction(id => window.broker.record('dk.deck', id)?.values['dk.deck.footer'] === 'Footer kept from before', deckRecord.recordId, { timeout: 5000 })
    .catch(() => { throw Error('Typing in the deck\'s fields not saved when the frame ended must be saved when the view starts again.'); });
  // Typing over a slide somebody changed while the view was away is held for the person, never saved on its own.
  await frame.evaluate(() => document.querySelectorAll('#slides li')[3].click());
  const heldSlide = (await state()).slideId;
  await frame.fill('#f-title', 'Mine from before');
  await page.evaluate(id => { window.broker.touch('dk.slide', id); window.broker.remount(); }, heldSlide);
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  await until(() => !document.getElementById('held').hidden)
    .catch(() => { throw Error('Typing over a slide that changed since must be offered back, not dropped.'); });
  assert((await record('dk.slide', heldSlide)).values['dk.slide.title'] !== 'Mine from before', 'Typing over a slide that changed since must not be saved without the person.');
  await frame.click('#held-put');
  await page.waitForFunction(id => window.broker.record('dk.slide', id)?.values['dk.slide.title'] === 'Mine from before', heldSlide, { timeout: 5000 });
  await until(() => document.getElementById('held').hidden && !Object.keys(localStorage).some(k => k.startsWith('deck.drafts.')));
  // A save the file refuses keeps the typing, on screen and on the device, and the next save takes it.
  await frame.evaluate(id => document.querySelector(`#slides li[data-id="${id}"]`).click(), heldSlide);
  await page.evaluate(() => window.broker.fail('records.update', { code: 'busy', message: 'The file is busy.' }));
  await frame.fill('#f-title', 'Refused once');
  await settle(1200);
  const refused = await frame.evaluate(id => ({ pending: window.deck.pending.has(id), kept: Object.keys(localStorage).some(k => k.startsWith('deck.drafts.')) }), heldSlide);
  assert(refused.pending && refused.kept, `A refused save must keep the typing: ${JSON.stringify(refused)}.`);
  await frame.fill('#f-title', 'Refused once, then saved');
  await page.waitForFunction(id => window.broker.record('dk.slide', id)?.values['dk.slide.title'] === 'Refused once, then saved', heldSlide, { timeout: 5000 });
  // A view opened read-only leaves typing kept from before on the device, for the next writable start.
  await page.evaluate(() => window.broker.fail('records.update', { code: 'busy', message: 'The file is busy.' }));
  await frame.fill('#f-title', 'Kept over a read-only start');
  await settle(1200);
  const readOnly = await frame.evaluate(async () => {
    window.deck.pending.clear();
    window.nendo.context.readOnly = true;
    window.dispatchEvent(new Event('pagehide'));
    await new Promise(r => setTimeout(r, 300));
    // The frame stays read-only until it ends; the next one starts writable.
    return { kept: Object.keys(localStorage).some(k => k.startsWith('deck.drafts.')) };
  });
  assert(readOnly.kept, 'A view opened read-only must leave the typing kept on the device.');
  await page.evaluate(() => window.broker.remount());
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  await page.waitForFunction(id => window.broker.record('dk.slide', id)?.values['dk.slide.title'] === 'Kept over a read-only start', heldSlide, { timeout: 5000 });
  // A start whose first read fails leaves typing kept from before for the next start, and restores it on its next good read.
  const keptOver = async (text, after) => {
    await page.evaluate(() => window.broker.fail('records.update', { code: 'busy', message: 'The file is busy.' }));
    const id = (await state()).slideId;
    await frame.fill('#f-title', text);
    await settle(1200);
    await page.evaluate(() => { window.broker.fail('records.query', { code: 'busy', message: 'The file is busy.' }); window.broker.remount(); });
    await page.waitForTimeout(300);
    frame = await mounted();
    await ready();
    await after();
    await page.waitForFunction(({ id, text }) => window.broker.record('dk.slide', id)?.values['dk.slide.title'] === text, { id, text }, { timeout: 5000 })
      .catch(async () => { throw Error(`Typing kept from before a start whose first read failed must be saved later: ${JSON.stringify((await record('dk.slide', id)).values['dk.slide.title'])}.`); });
  };
  await keptOver('Kept over a failed start', async () => { await page.evaluate(() => window.broker.remount()); await page.waitForTimeout(300); frame = await mounted(); await ready(); });
  await keptOver('Restored on the next good read', () => page.evaluate(() => window.broker.pushChanges()));
  // A refused write whose words the record already holds keeps the typing made while it was out.
  // The changes from the steps before are read first, so the view does not see the other writer's save.
  await settle(1000);
  const bothSlide = (await state()).slideId;
  await page.evaluate(id => {
    const r = window.broker.record('dk.slide', id);
    window.broker.put('dk.slide', { ...r, version: r.version + 1, values: { ...r.values, 'dk.slide.title': 'Typed by both' } });
    window.broker.hold('records.update', 900);
  }, bothSlide);
  await frame.fill('#f-title', 'Typed by both');
  await settle(900);
  await frame.fill('#f-title', 'Typed while the write was out');
  await page.waitForFunction(id => window.broker.record('dk.slide', id)?.values['dk.slide.title'] === 'Typed while the write was out', bothSlide, { timeout: 5000 })
    .catch(async () => { throw Error(`Typing made while a refused write was out must stay: ${JSON.stringify((await record('dk.slide', bothSlide)).values['dk.slide.title'])}.`); });
  checks.push('typing kept over a remount');

  // 14. Opening another deck waits for the slide's save in flight, and typing in the deck's own
  // fields stays with the deck it was typed in: two fields in one pause both land, and a deck opened
  // before the pause takes neither.
  const firstDeck = await record('dk.deck', deckRecord.recordId);
  await page.evaluate(d => {
    window.broker.put('dk.deck', { ...d, recordId: 'dk.deck.second', version: 1, values: { ...d.values, 'dk.deck.title': 'Second deck', 'dk.deck.subtitle': null, 'dk.deck.footer': null } });
    window.broker.pushChanges();
  }, firstDeck);
  await until(() => window.deck.decks.length === 2);
  await frame.click('#tab-design');
  await frame.fill('#d-subtitle', 'Typed subtitle');
  await frame.fill('#d-footer', 'Typed footer');
  await page.evaluate(() => window.broker.pushPlace({ deck: 'dk.deck.second' }));
  await until(() => window.deck.deckId === 'dk.deck.second');
  await settle(1200);
  const [one, two] = [await record('dk.deck', deckRecord.recordId), await record('dk.deck', 'dk.deck.second')];
  assert(one.values['dk.deck.subtitle'] === 'Typed subtitle' && one.values['dk.deck.footer'] === 'Typed footer' && !two.values['dk.deck.subtitle'] && !two.values['dk.deck.footer'],
    `Both fields typed in one pause must land on the deck they were typed in: ${JSON.stringify({ one: [one.values['dk.deck.subtitle'], one.values['dk.deck.footer']], two: [two.values['dk.deck.subtitle'], two.values['dk.deck.footer']] })}.`);
  await page.evaluate(id => window.broker.pushPlace({ deck: id }), deckRecord.recordId);
  await until(id => window.deck.deckId === id && window.deck.slides.length > 0, deckRecord.recordId);
  await frame.click('#tab-slide');
  await page.evaluate(() => window.broker.hold('records.update', 900));
  await frame.fill('#f-title', 'Slow title');
  const asked = Date.now();
  await page.evaluate(() => window.broker.pushPlace({ deck: 'dk.deck.second' }));
  await until(() => window.deck.deckId === 'dk.deck.second');
  const waited = Date.now() - asked;
  assert(waited >= 700, `Opening another deck must wait for the slide's save in flight: it opened after ${waited} ms of a 900 ms write.`);
  checks.push('saves wait, deck typing stays with its deck');

  // 15. Words are edited where they stand on the slide, as in PowerPoint: a click puts the caret
  // between two letters, typing goes in there, a selection is replaced, undo takes it back, marks,
  // lists and levels follow the keys, the right-click menu sets alignment, size and bullets, the
  // clipboard carries marks both ways, and a cell of a row or a table is edited on its own.
  await page.evaluate(fixture => { window.broker.setFixture(fixture); window.broker.remount(); }, fixture);
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.evaluate(() => localStorage.clear());
  await ready();
  const at = await page.locator('iframe').first().boundingBox();
  /** The page point inside character `index` of the words of the box `selector`; `side` is how far across it. */
  const charPoint = (selector, index, side = 0.5) => frame.evaluate(({ selector, index, side }) => {
    const box = document.querySelector(selector);
    const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let left = index;
    while (walk.nextNode()) {
      const node = walk.currentNode;
      if (node.parentElement.closest('.dk-b')) continue;
      if (left < node.length) { const r = document.createRange(); r.setStart(node, left); r.setEnd(node, left + 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width * side, y: b.top + b.height / 2 }; }
      left -= node.length;
    }
    return null;
  }, { selector, index, side });
  const clickAt = async (selector, index, side = 0.5, options = {}) => {
    const point = await charPoint(selector, index, side);
    assert(point, `The stage must draw the words of ${selector}.`);
    await page.mouse.click(at.x + point.x, at.y + point.y, options);
  };
  const editing = () => frame.evaluate(() => window.deck.stageEditor());
  const current = () => frame.evaluate(() => { const s = window.deck.slides.find(x => x.id === window.deck.slideId); return { id: s.id, title: s.title, body: s.body, format: s.format }; });
  const openSlide = async n => { await frame.evaluate(n => document.querySelectorAll('#slides li')[n].click(), n); await until(n => window.deck.slideId === window.deck.slides[n].id, n); };
  const openLayout = async layout => openSlide(await frame.evaluate(layout => window.deck.slides.findIndex(s => s.layout === layout), layout));
  const TITLE = '#stage .dk-t[data-field="title"]', BODY = '#stage .dk-t[data-field="body"]';
  await openSlide(4);
  const bullets = await current();
  assert(bullets.title === 'Short lines read faster than paragraphs', `The fifth example slide must be the Bullets slide: ${JSON.stringify(bullets.title)}.`);
  // A click between "Short" and " lines" puts the caret there, and a letter typed goes in there.
  await clickAt(TITLE, 4, 0.9);
  const placed = await editing();
  assert(placed?.field === 'title' && placed.sel.focus.o === 5, `A click inside the title must put the caret between the letters clicked: ${JSON.stringify(placed && { field: placed.field, sel: placed.sel })}.`);
  await page.keyboard.type('X');
  assert((await current()).title === 'ShortX lines read faster than paragraphs', `A letter typed must go in where the caret is, not at the end: ${JSON.stringify((await current()).title)}.`);
  await page.waitForFunction(id => window.broker.record('dk.slide', id)?.values['dk.slide.title'] === 'ShortX lines read faster than paragraphs', bullets.id, { timeout: 5000 })
    .catch(() => { throw Error('Words typed on the stage must be saved after a pause.'); });
  // Shift and an arrow select; typing replaces the selection; undo and redo step through it.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  const selected = await editing();
  assert(selected.sel.anchor.o === 6 && selected.sel.focus.o === 9, `Shift and an arrow must select letters: ${JSON.stringify(selected.sel)}.`);
  await page.keyboard.type('Y');
  assert((await current()).title === 'ShortXYnes read faster than paragraphs', `Typing must replace the selection: ${JSON.stringify((await current()).title)}.`);
  await page.keyboard.press('Control+z');
  const undone = await editing();
  assert((await current()).title === 'ShortX lines read faster than paragraphs' && undone.sel.anchor.o === 6 && undone.sel.focus.o === 9,
    `Ctrl Z must take the typing back and select what it replaced: ${JSON.stringify([(await current()).title, undone.sel])}.`);
  await page.keyboard.press('Control+y');
  assert((await current()).title === 'ShortXYnes read faster than paragraphs', `Ctrl Y must put the typing back: ${JSON.stringify((await current()).title)}.`);
  // A double click selects a word; Ctrl I and Ctrl U mark it.
  const word = await charPoint(TITLE, 12);
  await page.mouse.dblclick(at.x + word.x, at.y + word.y);
  const doubled = await editing();
  // Windows takes the space after the word in too, as PowerPoint does there; the marks leave it out.
  assert(doubled.sel.anchor.o === 11 && (doubled.sel.focus.o === 15 || doubled.sel.focus.o === 16), `A double click must select the word: ${JSON.stringify(doubled.sel)}.`);
  // Where the double click left the space out, Shift and an arrow take it in, so both ways mark "read " below.
  if (doubled.sel.focus.o === 15) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+i');
  await page.keyboard.press('Control+u');
  assert((await current()).title === 'ShortXYnes _<u>read</u>_ faster than paragraphs', `Ctrl I and Ctrl U must mark the selected word: ${JSON.stringify((await current()).title)}.`);
  // The body: Enter makes the next bullet, Tab takes it a level in, Backspace at its start takes the level, then the bullet, then joins.
  await clickAt(BODY, 10);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('New point');
  const [first, ...others] = bullets.body.split('\n'), lines = n => (async () => (await current()).body.split('\n').slice(0, n).join('\n'))();
  assert(await lines(3) === [first, '- New point', others[0]].join('\n'), `Enter at the end of a bullet must make the next one: ${JSON.stringify((await current()).body)}.`);
  await page.keyboard.press('Tab');
  assert(await lines(3) === [first, '  - New point', others[0]].join('\n'), `Tab must take a bullet a level in: ${JSON.stringify((await current()).body)}.`);
  await page.keyboard.press('Home');
  const steps = [];
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Backspace'); steps.push(await lines(3)); }
  assert(JSON.stringify(steps) === JSON.stringify([[first, '- New point', others[0]], [first, 'New point', others[0]], [`${first}New point`, ...others.slice(0, 2)]].map(l => l.join('\n'))),
    `Backspace at a bullet's start must take its level, then its bullet, then join it to the line above: ${JSON.stringify(steps)}.`);
  // Six changes: Enter, the typing, Tab and three Backspaces.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z');
  assert((await current()).body === bullets.body, `Undo must take the body back to what it was: ${JSON.stringify((await current()).body)}.`);
  // The right-click menu: PowerPoint's items, and its submenus work from the keyboard.
  await clickAt(BODY, 3, 0.5, { button: 'right' });
  const menu = await frame.evaluate(() => ({ items: [...document.querySelectorAll('.tx-popup .tx-menu > [role^="menuitem"] .tx-text')].map(b => b.textContent), bar: [...document.querySelectorAll('.tx-popup .tx-bar [aria-label]')].map(b => b.getAttribute('aria-label')) }));
  assert(JSON.stringify(menu.items) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Bold', 'Italic', 'Underline', 'Font size', 'Alignment', 'Bullets and numbering', 'Select all']) && menu.bar.includes('Font size') && menu.bar.includes('Bold'),
    `A right click on words must open the text menu and the mini toolbar: ${JSON.stringify(menu)}.`);
  for (let i = 0; i < 12 && !/^Alignment/.test(await frame.evaluate(() => document.activeElement?.textContent ?? '')); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const centred = await frame.evaluate(() => ({ format: window.deck.slides.find(x => x.id === window.deck.slideId).format, align: getComputedStyle(document.querySelector('#stage .dk-t[data-field="body"]')).textAlign, open: !!document.querySelector('.tx-popup') }));
  assert(centred.format === '{"body":{"align":"center"}}' && centred.align === 'center' && !centred.open, `Alignment, Centre, picked from the keyboard must centre the body: ${JSON.stringify(centred)}.`);
  await clickAt(BODY, 3, 0.5, { button: 'right' });
  await frame.selectOption('.tx-popup .tx-size', '32');
  const sized = await frame.evaluate(() => ({ format: JSON.parse(window.deck.slides.find(x => x.id === window.deck.slideId).format), size: document.querySelector('#stage .dk-t[data-field="body"]').dataset.size }));
  assert(Math.abs(Number(sized.size) * 0.75 - 32) < 0.05 && sized.format.body.align === 'center', `32 pt from the mini toolbar must draw the body at 32 pt and keep its alignment: ${JSON.stringify(sized)}.`);
  await clickAt(BODY, 3, 0.5, { button: 'right' });
  await frame.locator('.tx-popup .tx-menu > button', { hasText: 'Bullets and numbering' }).hover();
  await frame.locator('.tx-popup .tx-sub > button', { hasText: 'Numbering' }).click();
  assert((await current()).body.startsWith(`1. ${first.slice(2)}\n`), `Numbering from the menu must number the paragraph: ${JSON.stringify((await current()).body)}.`);
  // The clipboard: a copy carries plain text and HTML with the marks; a paste of HTML keeps its bold.
  await clickAt(TITLE, 2);
  await page.keyboard.press('Control+a');
  const copied = await frame.evaluate(() => {
    const data = new DataTransfer();
    document.querySelector('#stage .dk-t.editing').dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { plain: data.getData('text/plain'), html: data.getData('text/html') };
  });
  assert(copied.plain === 'ShortXYnes read faster than paragraphs' && copied.html.includes('<em><u>read</u></em>'), `A copy must carry the words and their marks: ${JSON.stringify(copied)}.`);
  await clickAt(BODY, 4, 0.9);
  const pasted = await frame.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<meta charset="utf-8"><p><b>Pasted</b> words</p>');
    data.setData('text/plain', 'Pasted words');
    document.querySelector('#stage .dk-t.editing').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return window.deck.slides.find(x => x.id === window.deck.slideId).body.split('\n')[0];
  });
  assert(pasted === `1. Write**Pasted** words${first.slice(7)}`, `A paste must go in at the caret with its bold: ${JSON.stringify(pasted)}.`);
  // A space before a paragraph's words is not kept, and the caret stays before the words it shows.
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(' ');
  const lead = await editing();
  assert(lead.text[0] === `Write**Pasted** words${first.slice(7)}`.replace('**Pasted**', 'Pasted') && lead.sel.focus.o === 0,
    `A space typed before a paragraph's words must leave the words and the caret as the box shows them: ${JSON.stringify({ text: lead.text[0].slice(0, 20), sel: lead.sel })}.`);
  // A list from Word, its words wrapped in paragraphs, pasted over the whole body stays a list.
  await page.keyboard.press('Control+a');
  const list = await frame.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<ul><li><p>First</p></li><li><p><b>Second</b></p></li></ul>');
    data.setData('text/plain', 'First\nSecond');
    document.querySelector('#stage .dk-t.editing').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return window.deck.slides.find(x => x.id === window.deck.slideId).body;
  });
  assert(list === '- First\n- **Second**', `A pasted list must keep its bullets, also when its items wrap their words in paragraphs: ${JSON.stringify(list)}.`);
  // A copied word with its space after it pastes with the space.
  await page.keyboard.press('Home');
  const spacedPaste = await frame.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>Big </p>');
    data.setData('text/plain', 'Big ');
    document.querySelector('#stage .dk-t.editing').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return window.deck.slides.find(x => x.id === window.deck.slideId).body;
  });
  assert(spacedPaste === '- First\n- Big **Second**', `A paste must keep the space at the end of what was copied: ${JSON.stringify(spacedPaste)}.`);
  // Escape ends the editing; the box is drawn as words again.
  await page.keyboard.press('Escape');
  const ended = await frame.evaluate(() => ({ session: window.deck.stageEditor(), editable: document.querySelectorAll('#stage [contenteditable="true"]').length }));
  assert(!ended.session?.field && ended.editable === 0, `Escape must end the editing: ${JSON.stringify(ended)}.`);
  // Larger, pressed past the largest size a slide keeps, stops there rather than going back to the layout's.
  await clickAt('#stage .dk-t[data-field="kicker"]', 2);
  const scales = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Control+BracketRight');
    scales.push(await frame.evaluate(() => JSON.parse(window.deck.slides.find(x => x.id === window.deck.slideId).format || '{}').kicker?.size ?? 1));
  }
  assert(scales.every((s, i) => s >= (scales[i - 1] ?? 1)) && scales.at(-1) > 4 && scales.at(-1) <= 6,
    `Larger pressed many times must step up and stop at the largest size the slide keeps, never back to the layout's: ${JSON.stringify(scales)}.`);
  await page.keyboard.press('Escape');
  // A card's heading and a table's cell are edited on their own; the rest of the line stays as it was.
  await openLayout('Cards');
  const cards = await current();
  await clickAt('#stage .dk-t[data-key="body.0"]', 2, 0.9);
  await page.keyboard.type('Z');
  const card = (await current()).body.split('\n');
  assert(card[0] === '- KeyZnote | a dark stage and one bright accent' && card.slice(1).join('\n') === cards.body.split('\n').slice(1).join('\n'), `Typing in a card's heading must change that cell only: ${JSON.stringify(card[0])}.`);
  await page.keyboard.press('Home');
  await page.keyboard.type(' Q');
  const spaced = { line: (await current()).body.split('\n')[0], field: (await editing())?.field };
  assert(spaced.line === '- QKeyZnote | a dark stage and one bright accent' && spaced.field === 'body', `A space typed before a cell's words must keep the cell in editing: ${JSON.stringify(spaced)}.`);
  // A card heading deleted whole keeps its box in editing, and new words go in its place.
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Fresh');
  const replaced = { line: (await current()).body.split('\n')[0], field: (await editing())?.field };
  assert(replaced.line === '- Fresh | a dark stage and one bright accent' && replaced.field === 'body', `A cell emptied and typed into again must keep its place: ${JSON.stringify(replaced)}.`);
  for (let i = 0; i < 2; i++) await page.keyboard.press('Control+z');
  await openLayout('Table');
  const tables = await current();
  const cell = await frame.evaluate(() => [...document.querySelectorAll('#stage .dk-t[data-field="body"]')].findIndex(b => b.textContent === 'any browser'));
  assert(cell >= 0, 'The table slide must draw the cell "any browser" as words of the body.');
  await frame.evaluate(i => [...document.querySelectorAll('#stage .dk-t[data-field="body"]')][i].setAttribute('data-probe', 'cell'), cell);
  await clickAt('#stage [data-probe="cell"]', 2, 0.9);
  await page.keyboard.type('!');
  const table = (await current()).body.split('\n');
  assert(table[2] === '| HTML | any! browser | sharing a link or a file |' && table.filter((_, i) => i !== 2).join('\n') === tables.body.split('\n').filter((_, i) => i !== 2).join('\n'),
    `Typing in a table cell must change that cell only: ${JSON.stringify(table[2])}.`);
  await page.keyboard.press('Escape');
  await command('slide.delete');
  await until(id => !window.deck.slides.some(s => s.id === id) && !!window.deck.slideId, tables.id);
  const left = await current();
  await frame.evaluate(() => document.activeElement?.blur());
  // One Ctrl Z for the slides and the words: the delete first, the slide back under its own ID with
  // the cell typed in it, then that typing, then the change before it on the Cards slide.
  await page.keyboard.press('Control+z');
  await until(id => window.deck.slides.some(s => s.id === id) && window.deck.slideId === id, tables.id, 5000)
    .catch(() => { throw Error('Ctrl Z after a delete must bring the deleted slide back, under its own ID, as the current slide.'); });
  const back = await current();
  assert(back.body.split('\n')[2] === '| HTML | any! browser | sharing a link or a file |', `The slide Ctrl Z brings back must hold what was typed in it: ${JSON.stringify(back.body.split('\n')[2])}.`);
  await page.keyboard.press('Control+z');
  await until(id => window.deck.slides.find(s => s.id === id)?.body.split('\n')[2] === '| HTML | any browser | sharing a link or a file |', tables.id, 3000)
    .catch(async () => { throw Error(`The next Ctrl Z must take back the typing on the slide that came back: ${JSON.stringify((await current()).body.split('\n')[2])}.`); });
  await page.keyboard.press('Control+z');
  await settle(300);
  const after = await frame.evaluate(({ left, cards }) => ({ left: window.deck.slides.find(s => s.id === left), cards: window.deck.slides.find(s => s.id === cards).body.split('\n')[0], on: window.deck.slideId }), { left: left.id, cards: cards.id });
  assert(after.left.body === left.body && after.left.title === left.title && after.cards === '- KeyZnote | a dark stage and one bright accent' && after.on === cards.id,
    `The Ctrl Z after those must change no other slide, and take back the change before them on the Cards slide: ${JSON.stringify({ was: left.body.slice(0, 50), now: after.left.body.slice(0, 50), cards: after.cards, on: after.on })}.`);
  checks.push('words edited on the stage');

  // 17. Slides rearranged as in PowerPoint, on the example deck again: a click picks, Ctrl and Shift
  // pick more; a drag moves the pick as one block with a mark where it lands, Ctrl copies; the keys
  // move it; cut, copy and paste carry slides; the slides' menu, the sorter's grid; and Ctrl Z and
  // Ctrl Y take each of these back and forth, by hand where Nendo refuses.
  await page.evaluate(fixture => { window.broker.setFixture(fixture); window.broker.remount(); }, fixture);
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  // Its own block: the names below are this check's.
  {
  const order = () => frame.evaluate(() => window.deck.slides.map(s => s.id));
  const picked = () => frame.evaluate(() => ({ selected: window.deck.slides.filter(s => window.deck.selected.includes(s.id)).map(s => s.id), current: window.deck.slideId }));
  const deckId = await frame.evaluate(() => window.deck.deckId);
  const fileOrder = async () => (await records('dk.slide')).filter(r => r.values['dk.slide.deck'] === deckId)
    .sort((a, b) => a.values['dk.slide.order'] - b.values['dk.slide.order'] || a.recordId.localeCompare(b.recordId)).map(r => r.recordId);
  const lastBatch = async () => (await requests('records.batch')).at(-1);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const onScreenAndInFile = async (want, what) => {
    await until(want => JSON.stringify(window.deck.slides.map(s => s.id)) === JSON.stringify(want), want, 5000)
      .catch(async () => { throw Error(`${what}: the list shows ${JSON.stringify((await order()).map(id => want.indexOf(id)))}.`); });
    // The list moves at once; the file follows when the batch lands.
    for (let i = 0; i < 50 && !same(await fileOrder(), want); i++) await page.waitForTimeout(100);
    const file = await fileOrder();
    assert(same(file, want), `${what}: the file's orders read ${JSON.stringify(file.map(id => want.indexOf(id)))}.`);
  };
  const thumb = i => frame.locator('#slides li[data-id]').nth(i);
  const start = await order();
  const n = start.length;

  // Clicks pick: one, Ctrl adds, Shift runs from the anchor.
  await thumb(1).click();
  await thumb(3).click({ modifiers: ['Control'] });
  let p = await picked();
  assert(same(p.selected, [start[1], start[3]]) && p.current === start[3], `Ctrl and a click must add a slide to the pick: ${JSON.stringify(p)}.`);
  assert(await frame.locator('#slides li[aria-selected="true"]').count() === 2, 'The list must mark both picked slides.');
  // The pick, dragged by one of its slides, lands as one block before the first slide: two orders written.
  const air = await dragSlide(3, 0, { release: false });
  assert(air.drag.active && same(air.drag.ids, [start[1], start[3]]) && air.mark && air.lifted === 2 && air.ghost === '2',
    `A drag must lift the whole pick, show the count under the pointer and a mark where it lands: ${JSON.stringify(air)}.`);
  // A change to the file heard mid-drag waits: a redraw would drop the lifted slides and the mark.
  await page.evaluate(() => window.broker.pushChanges());
  await settle(600);
  const held = await frame.evaluate(() => ({ mark: !!document.querySelector('.drop-mark:not([hidden])'), lifted: document.querySelectorAll('#slides li.lifted').length }));
  assert(held.mark && held.lifted === 2, `A change heard during a drag must leave the lifted slides and the mark in place: ${JSON.stringify(held)}.`);
  await page.mouse.up();
  const moved2 = [start[1], start[3], start[0], start[2], ...start.slice(4)];
  await onScreenAndInFile(moved2, 'Two picked slides dragged before the first must stand first, in their order');
  const moveBatch = await lastBatch();
  assert(moveBatch.label === 'Move 2 slides' && moveBatch.offerUndo === true && moveBatch.writes.length === 2,
    `A move must be one labelled batch that writes only the orders that must change: ${JSON.stringify({ label: moveBatch.label, writes: moveBatch.writes.length })}.`);
  // A drop where the block already stands writes nothing.
  const quiet = (await requests('records.batch')).length;
  const still = await dragSlide(0, 2);
  await settle(300);
  assert(!still.mark && (await requests('records.batch')).length === quiet && same(await order(), moved2), `A pick dropped where it stands must show no mark and write nothing: ${JSON.stringify(still)}.`);
  // Ctrl Z and Ctrl Y, with the list holding the keys.
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Ctrl Z must put the moved slides back');
  await page.keyboard.press('Control+y');
  await onScreenAndInFile(moved2, 'Ctrl Y must move them again');
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Ctrl Z again must put them back again');
  assert((await requests('records.undo')).length >= 2 && (await requests('records.redo')).length >= 1, 'Ctrl Z and Ctrl Y must take the step back through Nendo\'s own undo and redo.');
  checks.push('pick and drag');

  // Keys: Shift and an arrow pick a run, Ctrl and an arrow move it, Ctrl Shift and an arrow to the end.
  await thumb(2).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  p = await picked();
  assert(same(p.selected, start.slice(2, 5)) && p.current === start[4], `Shift and an arrow must pick a run of slides: ${JSON.stringify(p.selected.map(id => start.indexOf(id)))}.`);
  await page.keyboard.press('Control+ArrowUp');
  await onScreenAndInFile([start[0], start[2], start[3], start[4], start[1], ...start.slice(5)], 'Ctrl Up must move the picked run up one place');
  await page.keyboard.press('Control+Shift+ArrowDown');
  const atEnd = [start[0], start[1], ...start.slice(5), start[2], start[3], start[4]];
  await onScreenAndInFile(atEnd, 'Ctrl Shift Down must move the pick to the end');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Two Ctrl Z must take both moves back');
  await page.keyboard.press('Escape');
  p = await picked();
  assert(p.selected.length === 1, `Escape in the list must leave the current slide alone picked: ${p.selected.length}.`);
  checks.push('keys move slides');

  // Copy and paste with the keys: the clipboard carries Deck's own type and the words; the paste lands
  // after the pick, as copies, picked.
  await frame.evaluate(() => {
    window.__copied = null;
    document.addEventListener('copy', e => { window.__copied = { slides: e.clipboardData.getData('application/x-nendo-deck-slides'), text: e.clipboardData.getData('text/plain'), kept: e.defaultPrevented }; });
  });
  await thumb(5).click();
  await thumb(6).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+c');
  const copied = await frame.evaluate(() => window.__copied);
  const carried = JSON.parse(copied?.slides || 'null');
  const titles = await frame.evaluate(ids => ids.map(id => window.deck.slides.find(s => s.id === id).title), [start[5], start[6]]);
  assert(copied?.kept && carried?.format === 'nendo.deck-slides' && same(carried.slides.map(s => s.title), titles) && copied.text.includes(titles[0]),
    `Ctrl C in the list must put the picked slides on the clipboard as Deck's slides and as words: ${JSON.stringify({ copied: !!copied, kept: copied?.kept, format: carried?.format })}.`);
  await page.keyboard.press('Control+v');
  await until(n => window.deck.slides.length === n, n + 2, 5000).catch(() => { throw Error('Ctrl V in the list must paste the two copied slides.'); });
  let now = await order();
  const pasted = now.slice(7, 9);
  p = await picked();
  const pastedTitles = await frame.evaluate(ids => ids.map(id => window.deck.slides.find(s => s.id === id)?.title), pasted);
  assert(same(pastedTitles, titles) && !start.includes(pasted[0]) && same(p.selected, pasted) && (await lastBatch()).label === 'Paste 2 slides',
    `The paste must land right after the pick as new slides, picked: ${JSON.stringify({ pastedTitles, picked: p.selected.map(id => now.indexOf(id)) })}.`);
  assert(same(await fileOrder(), now), 'The pasted slides must stand in the file where the list shows them.');
  // Cut takes the pick out in one step; a paste at the start puts it there.
  await page.keyboard.press('Control+x');
  await until(n => window.deck.slides.length === n, n, 5000);
  assert((await lastBatch()).label === 'Cut 2 slides', `Ctrl X must cut the pick as one step: ${(await lastBatch()).label}.`);
  await thumb(0).click();
  await page.keyboard.press('Control+v');
  await until(n => window.deck.slides.length === n, n + 2, 5000);
  now = await order();
  assert(same(await frame.evaluate(ids => ids.map(id => window.deck.slides.find(s => s.id === id).title), now.slice(1, 3)), titles), 'A cut pasted after the first slide must stand second and third.');
  for (let i = 0; i < 2; i++) await page.keyboard.press('Control+z');
  await onScreenAndInFile([...start.slice(0, 7), ...pasted, ...start.slice(7)], 'Two Ctrl Z must take back the second paste and the cut, and the cut slides come back under their own IDs');
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'A third Ctrl Z must take back the first paste');
  // A paste reads at most 100 slides, so cut and copy refuse a bigger pick before anything is deleted.
  assert(n * 8 > 100, `The example needs more than 12 slides for the cut limit check: ${n}.`);
  await thumb(0).click();
  for (const size of [n * 2, n * 4, n * 8]) {
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+d');
    await until(size => window.deck.slides.length === size, size, 10000).catch(() => { throw Error(`Ctrl A and Ctrl D must grow the deck to ${size} slides.`); });
  }
  const before = (await requests('records.batch')).length;
  await frame.evaluate(() => { window.__cut = ''; document.addEventListener('cut', e => { window.__cut = e.clipboardData.getData('application/x-nendo-deck-slides'); }); });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+x');
  await settle(400);
  const refused = await frame.evaluate(() => ({ slides: window.deck.slides.length, copied: window.__cut, toast: document.getElementById('toast').textContent }));
  assert(refused.slides === n * 8 && (await requests('records.batch')).length === before && !refused.copied && /up to 100 slides/.test(refused.toast),
    `Ctrl X on more than 100 slides must delete nothing, copy nothing and say why: ${JSON.stringify({ ...refused, batches: (await requests('records.batch')).length - before })}.`);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Three Ctrl Z must take back the three duplicates');
  await thumb(0).click();
  checks.push('cut, copy, paste');

  // Ctrl held at the drop copies the slide there; Delete takes a pick out in one step, and Ctrl Z
  // brings it back.
  const copyAir = await dragSlide(0, 2, { ctrl: true });
  assert(copyAir.copy, 'Ctrl held during a drag must show the copy mark.');
  await until(n => window.deck.slides.length === n, n + 1, 5000).catch(() => { throw Error('A drag with Ctrl held must copy the slide.'); });
  now = await order();
  const firstTitle = await frame.evaluate(id => window.deck.slides.find(s => s.id === id).title, start[0]);
  assert(same(now.filter(id => id !== now[2]), start) && await frame.evaluate(id => window.deck.slides.find(s => s.id === id).title, now[2]) === firstTitle && (await lastBatch()).label === 'Copy a slide',
    `A Ctrl drag must put a copy where it was dropped and leave the slide where it was: ${JSON.stringify(now.map(id => start.indexOf(id)))}.`);
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Ctrl Z must take the copy back');
  await thumb(8).click();
  await thumb(9).click({ modifiers: ['Control'] });
  await page.keyboard.press('Delete');
  await until(n => window.deck.slides.length === n, n - 2, 5000).catch(() => { throw Error('Delete in the list must delete both picked slides.'); });
  assert((await lastBatch()).label === 'Delete 2 slides', `Delete must take the pick out in one step: ${(await lastBatch()).label}.`);
  p = await picked();
  assert(p.current === start[10], `After a delete the slide after the deleted ones must be current: ${start.indexOf(p.current)}.`);
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Ctrl Z must bring both deleted slides back where they stood');
  // Words typed in the inspector after that end the redo: Ctrl Y must not delete the slides again.
  const typedIn = (await picked()).current;
  const oldTitle = await frame.evaluate(id => window.deck.slides.find(s => s.id === id).title, typedIn);
  await frame.fill('#f-title', 'Typed after the undo');
  await frame.evaluate(() => document.activeElement.blur());
  await until(id => !window.deck.pending.has(id), typedIn, 5000);
  await frame.locator('#slides').focus();
  await page.keyboard.press('Control+y');
  await settle(500);
  assert((await frame.evaluate(id => window.deck.slides.find(s => s.id === id)?.title ?? null, typedIn)) === 'Typed after the undo' && (await order()).length === n,
    `Ctrl Y after new typing must not put back the delete: ${JSON.stringify({ slides: (await order()).length, batch: (await lastBatch()).label })}.`);
  await thumb(start.indexOf(typedIn)).click();
  await frame.fill('#f-title', oldTitle);
  await frame.evaluate(() => document.activeElement.blur());
  await until(id => !window.deck.pending.has(id), typedIn, 5000);
  checks.push('copy by drag, delete');

  // The slides' menu: a right click on a picked slide keeps the pick, and Hide hides both in one step.
  await thumb(3).click();
  await thumb(4).click({ modifiers: ['Shift'] });
  await page.evaluate(() => window.broker.pickNext({ id: 'slide.hide', value: true }));
  await thumb(4).click({ button: 'right' });
  await until(ids => ids.every(id => window.deck.slides.find(s => s.id === id)?.hidden), [start[3], start[4]], 5000)
    .catch(() => { throw Error('Hide from the slides\' menu must hide every picked slide.'); });
  const menu = await page.evaluate(() => window.broker.menus.at(-1));
  const menuIds = menu.items.map(it => it.id).filter(Boolean);
  assert(['slide.new', 'slide.duplicate', 'slide.cut', 'slide.copy', 'slide.paste', 'slide.hide', 'slide.top', 'slide.up', 'slide.down', 'slide.bottom', 'slide.delete'].every(id => menuIds.includes(id))
    && menu.items.find(it => it.id === 'slide.delete').label === 'Delete 2 slides', `The slides' menu must offer the slide commands, named for the pick: ${JSON.stringify(menu.items.map(it => it.label))}.`);
  assert((await lastBatch()).label === 'Hide 2 slides', `Hide must be one step for the pick: ${(await lastBatch()).label}.`);
  // A layout picked with two slides picked goes on both in one step.
  await frame.click('#tab-slide');
  await frame.click('#layouts [data-layout="Statement"]');
  await until(ids => ids.every(id => window.deck.slides.find(s => s.id === id)?.layout === 'Statement'), [start[3], start[4]], 5000)
    .catch(() => { throw Error('A layout picked with two slides picked must go on both.'); });
  await frame.locator('#slides').focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await until(ids => ids.every(id => !window.deck.slides.find(s => s.id === id)?.hidden), [start[3], start[4]], 5000);
  // A move Nendo will not take back, because a slide it moved was typed in since, is put back by hand.
  await thumb(2).click();
  await command('slide.down');
  await onScreenAndInFile([start[0], start[1], start[3], start[2], ...start.slice(4)], 'Move down must move the current slide');
  // The slide whose order the move wrote, typed in: its version is no longer the one the move left.
  const written = (await lastBatch()).writes[0].recordId;
  await thumb(start.indexOf(written) === 2 ? 3 : 2).click();
  await frame.fill('#f-title', 'Typed after the move');
  await frame.evaluate(() => document.activeElement.blur());
  await until(id => !window.deck.pending.has(id), written, 5000);
  const undosBefore = (await requests('records.undo')).length;
  await frame.locator('#slides').focus();
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Ctrl Z must put back a move whose slide was typed in since');
  assert((await requests('records.undo')).length === undosBefore + 1 && (await lastBatch()).label === 'Undo Move a slide' && (await record('dk.slide', written)).values['dk.slide.title'] === 'Typed after the move',
    `A move Nendo refuses to take back must be put back by a batch of its own, and keep the typing: ${(await lastBatch()).label}.`);
  // Cut from a menu, where the browser will not cut, copies the pick and deletes what it copied, also
  // when the pick changes while the clipboard write is out.
  await frame.evaluate(() => {
    window.__execCommand = document.execCommand; document.execCommand = () => false;
    window.__writes = []; navigator.clipboard.writeText = text => new Promise(resolve => window.__writes.push({ text, resolve }));
  });
  await thumb(5).click();
  await command('slide.cut');
  await until(() => window.__writes.length === 1, null, 5000).catch(() => { throw Error('Cut from a menu must write the pick to the clipboard.'); });
  await thumb(6).click();
  await frame.evaluate(() => { window.__writes[0].resolve(); document.execCommand = window.__execCommand; delete navigator.clipboard.writeText; });
  await until(n => window.deck.slides.length === n - 1, n, 5000).catch(() => { throw Error('Cut from a menu must delete the slide it copied.'); });
  const afterCut = await order();
  assert(!afterCut.includes(start[5]) && afterCut.includes(start[6]),
    `Cut must delete the slides it copied, not a pick made while it waited: ${JSON.stringify({ copiedGone: !afterCut.includes(start[5]), newPickKept: afterCut.includes(start[6]) })}.`);
  await frame.locator('#slides').focus();
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Ctrl Z must bring back the slide a menu Cut took');
  checks.push('slides menu, undo by hand');

  // The slide sorter: every slide on a grid; the arrows go across and down its rows, Ctrl and an arrow
  // moves, a drag shows a bar between cards, Enter goes back to the stage on the slide.
  await command('view.sorter', true);
  await until(n => !document.getElementById('grid-view').hidden && document.querySelectorAll('#grid li[data-id]').length === n && document.activeElement?.id === 'grid', n, 3000)
    .catch(() => { throw Error('The slide sorter must open over the view, with every slide and the keys.'); });
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.find(it => it.id === 'view.sorter')?.pressed === true, null, { timeout: 3000 })
    .catch(() => { throw Error('Nendo\'s row must show the slide sorter pressed while it is open.'); });
  const cols = await frame.evaluate(() => { const items = [...document.querySelectorAll('#grid li')]; const top = items[0].getBoundingClientRect().top; return items.filter(el => Math.abs(el.getBoundingClientRect().top - top) < 4).length; });
  assert(cols >= 3, `The sorter must lay the slides out in rows: ${cols} across.`);
  await frame.locator('#grid li[data-id]').nth(0).click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  p = await picked();
  assert(p.current === start[1 + cols], `Right and Down in the sorter must go one card across and one row down: slide ${start.indexOf(p.current) + 1}, not ${2 + cols}.`);
  await page.keyboard.press('Control+ArrowUp');
  const rowUp = [...start]; rowUp.splice(1 + cols, 1); rowUp.splice(1, 0, start[1 + cols]);
  await onScreenAndInFile(rowUp, 'Ctrl Up in the sorter must move the slide up a row');
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Ctrl Z in the sorter must put it back');
  const gridAir = await dragSlide(0, 3, { list: '#grid' });
  assert(gridAir.mark && await frame.evaluate(() => !document.querySelector('.drop-mark')), 'A drag in the sorter must show its mark while dragging, and take it away at the drop.');
  await onScreenAndInFile([start[1], start[2], start[0], ...start.slice(3)], 'A card dropped before the fourth must stand third');
  await page.keyboard.press('Enter');
  await until(id => document.getElementById('grid-view').hidden && window.deck.slideId === id && document.activeElement?.id === 'slides', start[0], 3000)
    .catch(() => { throw Error('Enter in the sorter must go back to the stage on the current slide.'); });
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Ctrl Z back on the stage must take back the sorter\'s move');
  const chromeLater = await page.evaluate(() => window.broker.chromeRefusals);
  assert(chromeLater.length === 0, `Nendo must accept every toolbar and menu the view declared: ${JSON.stringify(chromeLater)}.`);
  checks.push('slide sorter');

  // A step keeps the deck it changed, though another deck opens while its batch is out: Ctrl Z there
  // leaves this deck alone, and back here it takes the delete back.
  await page.evaluate(id => {
    const d = window.broker.record('dk.deck', id);
    window.broker.put('dk.deck', { ...d, recordId: 'dk.deck.other', version: 1, values: { ...d.values, 'dk.deck.title': 'Other deck' } });
    window.broker.pushChanges();
  }, deckId);
  await until(() => window.deck.decks.length === 2, null, 5000);
  await thumb(1).click();
  await page.evaluate(() => window.broker.hold('records.batch', 900));
  await page.keyboard.press('Delete');
  await page.evaluate(() => window.broker.pushPlace({ deck: 'dk.deck.other' }));
  await until(() => window.deck.deckId === 'dk.deck.other', null, 5000);
  await until(() => window.deck.steps.undo.at(-1)?.label === 'Delete slide 2', null, 5000).catch(() => { throw Error('The delete must land as a step.'); });
  const stepDeck = await frame.evaluate(() => window.deck.steps.undo.at(-1).deckId);
  await frame.locator('#slides').focus();
  await page.keyboard.press('Control+z');
  await settle(400);
  const stillGone = !(await fileOrder()).includes(start[1]);
  assert(stepDeck === deckId && stillGone, `A step must keep the deck it changed, and Ctrl Z in another deck must leave it: ${JSON.stringify({ stepDeck, stillGone })}.`);
  await page.evaluate(id => window.broker.pushPlace({ deck: id }), deckId);
  await until(id => window.deck.deckId === id && window.deck.slides.length > 0, deckId, 5000);
  await frame.locator('#slides').focus();
  await page.keyboard.press('Control+z');
  await onScreenAndInFile(start, 'Back in its deck, Ctrl Z must take the delete back');
  // Where Nendo will not take a delete back, the slide is made again by hand, naming its deck at the
  // version the deck has now, with the agent's variants on it; an earlier step on the slide follows
  // it to its new ID.
  await thumb(2).click();
  await page.evaluate(({ deckId, slideId }) => {
    window.broker.put('dk.ask', { entityId: 'dk.ask', recordId: 'dk.ask.arrange', version: 1, labels: {}, exact: {}, calculated: {},
      values: { 'dk.ask.deck': deckId, 'dk.ask.request': 'Shorter', 'dk.ask.scope': 'Selection', 'dk.ask.status': 'Done', 'dk.ask.made': '2026-10-24T09:00:00Z' } });
    window.broker.put('dk.variant', { entityId: 'dk.variant', recordId: 'dk.variant.arrange', version: 1, labels: {}, exact: {}, calculated: {},
      values: { 'dk.variant.ask': 'dk.ask.arrange', 'dk.variant.slide': slideId, 'dk.variant.label': 'Shorter', 'dk.variant.changes': '{"title":"Short"}', 'dk.variant.status': 'Proposed' } });
    window.broker.pushChanges();
  }, { deckId, slideId: start[2] });
  await until(() => window.deck.variants.length === 1, null, 5000);
  await command('slide.hide');
  await until(id => window.deck.slides.find(s => s.id === id)?.hidden === true, start[2], 5000);
  const goneTitle = await frame.evaluate(id => window.deck.slides.find(s => s.id === id).title, start[2]);
  await frame.locator('#slides').focus();
  await page.keyboard.press('Delete');
  await until(n => window.deck.slides.length === n - 1, n, 5000);
  await page.evaluate(() => window.broker.fail('records.undo', { code: 'stale', message: 'The file changed since.' }, 1));
  await page.keyboard.press('Control+z');
  await until(n => window.deck.slides.length === n, n, 5000).catch(async () => {
    throw Error(`Ctrl Z must make a deleted slide again where Nendo will not take the delete back: ${await frame.evaluate(() => String(window.deck.problem?.message ?? window.deck.problem ?? ''))}.`);
  });
  const remade = (await order())[2];
  assert(remade !== start[2] && await frame.evaluate(id => window.deck.slides.find(s => s.id === id).title, remade) === goneTitle && (await lastBatch()).label === 'Undo Delete slide 3',
    `A delete taken back by hand must make the slide again in its place, under a new ID: ${(await lastBatch()).label}.`);
  const variantsBack = (await records('dk.variant')).filter(r => r.values['dk.variant.slide'] === remade).length;
  assert(variantsBack === 1, `A delete taken back by hand must bring back the slide's variants with it: ${variantsBack} on the new slide.`);
  await page.evaluate(() => window.broker.fail('records.undo', { code: 'stale', message: 'The file changed since.' }, 1));
  await page.keyboard.press('Control+z');
  await settle(400);
  const hiddenAfter = (await records('dk.slide')).find(r => r.recordId === remade)?.values['dk.slide.hidden'];
  assert(hiddenAfter === false, `Ctrl Z after a slide came back under a new ID must take back the hide made before its delete: hidden is ${hiddenAfter}.`);
  checks.push('steps keep their deck');
  }

  // 16. A file with no deck opens on the start screen; its six templates fit the width.
  await page.evaluate(empty => { window.broker.setFixture(empty); window.broker.remount(); }, empty);
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  const start = await frame.evaluate(() => ({ shown: !document.getElementById('start').hidden, templates: document.querySelectorAll('#start-templates button').length,
    overflow: [...document.querySelectorAll('#start-templates button')].some(b => b.getBoundingClientRect().right > document.getElementById('start-form').getBoundingClientRect().right + 1),
    agent: !document.getElementById('start-agent').hidden }));
  assert(start.shown && start.templates === 6 && !start.overflow && start.agent, `An empty file must open on the start screen with six templates inside the form: ${JSON.stringify(start)}.`);
  await frame.fill('#start-name', 'A blank deck');
  await frame.click('#start-blank');
  await frame.waitForFunction(() => window.deck.decks.length === 1 && window.deck.slides.length === 1 && document.getElementById('start').hidden);
  // Deck typing queued behind a slow write stays with its deck when a new deck is made and typed in.
  const blank = await frame.evaluate(() => window.deck.deckId);
  await frame.click('#tab-design');
  await page.evaluate(() => window.broker.hold('records.update', 1500));
  await frame.fill('#d-goal', 'First goal, out');
  await settle(900);
  await frame.fill('#d-goal', 'First goal, queued');
  await command('new-deck');
  await frame.fill('#start-name', 'A second blank deck');
  await frame.click('#start-blank');
  await frame.waitForFunction(id => window.deck.decks.length === 2 && window.deck.deckId !== id && document.getElementById('start').hidden, blank, { timeout: 8000 });
  const made = await frame.evaluate(() => window.deck.deckId);
  await frame.click('#tab-design');
  await frame.fill('#d-goal', 'Second goal');
  await settle(3000);
  const goals = [(await record('dk.deck', blank)).values['dk.deck.goal'], (await record('dk.deck', made)).values['dk.deck.goal']];
  assert(goals[0] === 'First goal, queued' && goals[1] === 'Second goal', `Deck typing queued behind a write must stay with its deck when a new deck is made: ${JSON.stringify(goals)}.`);
  // A file whose only template is a design's shows the six built-in templates, the first chosen, and a
  // deck made from that screen takes the first of them, not the design hidden under Designs.
  const designOnly = JSON.parse(JSON.stringify(empty));
  const seed = (entityId, recordId, values) => ({ entityId, recordId, version: 1, values, labels: {}, exact: {}, calculated: {} });
  designOnly.records['dk.brand'] = [seed('dk.brand', 'brand-only', { 'dk.brand.name': 'Only Kit' })];
  designOnly.records['dk.template'] = [seed('dk.template', 'template-only', { 'dk.template.name': 'Only Design', 'dk.template.family': 'swiss', 'dk.template.brand': 'brand-only', 'dk.template.source': 'Brandkits:k-only' })];
  await page.evaluate(fixture => { window.broker.setFixture(fixture); window.broker.remount(); }, designOnly);
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  const offered = await frame.evaluate(() => [...document.querySelectorAll('#start-templates button')].map(b => ({ id: b.dataset.template, chosen: b.getAttribute('aria-selected') })));
  assert(offered.length === 6 && offered.every(b => b.id === '') && offered[0].chosen === 'true', `With only a design in the file, the start screen must offer the six built-in templates, the first chosen: ${JSON.stringify(offered)}.`);
  await frame.fill('#start-name', 'From the start screen');
  await frame.click('#start-blank');
  await frame.waitForFunction(() => window.deck.decks.length === 1 && document.getElementById('start').hidden, null, { timeout: 8000 });
  const startedOn = await frame.evaluate(() => window.deck.decks[0].values['dk.deck.template'] ?? null);
  assert(startedOn === null, `A deck made with the first built-in template chosen must not take the design's template: ${startedOn}.`);
  checks.push('start screen');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, errors, contrast: { light: light.ratio, dark: dark.ratio } };
  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
