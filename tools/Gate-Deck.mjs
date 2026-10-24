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
  assert(await frame.locator('#layouts .thumb').count() === 17, 'The layout gallery must draw all seventeen layouts.');
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
  await command('add.10');
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
  // A thumbnail dropped below the list goes to the end, then back before the second.
  const moved = (await state()).slides[1].id;
  const drag = (fromIndex, beforeIndex) => frame.evaluate(({ fromIndex, beforeIndex }) => {
    const list = document.getElementById('slides'), items = list.querySelectorAll('li[data-id]'), dt = new DataTransfer();
    items[fromIndex].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    (beforeIndex === null ? list : items[beforeIndex]).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { fromIndex, beforeIndex });
  await drag(1, null);
  await until(id => window.deck.slides.at(-1)?.id === id, moved, 3000)
    .catch(async () => { const order = (await state()).slides.map(x => x.id); throw Error(`A slide dropped below the list must go to the end: it is at ${order.indexOf(moved) + 1} of ${order.length}.`); });
  await drag(exampleSlides - 1, 1);
  await until(id => window.deck.slides[1]?.id === id, moved, 3000);
  const batches = await requests('records.batch');
  assert(batches.length >= 3 && batches.slice(-3).every(b => b.offerUndo === true && typeof b.label === 'string'), 'Add, move and delete must each be a labelled batch that offers Undo.');
  checks.push('add, move, delete');

  // 6. A picture dropped on the stage goes into the slide's picture field in the same revision.
  await frame.evaluate(() => document.querySelectorAll('#slides li')[7].click());
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
  const notes = await exported('export.notes', 'md');
  assert(notes.name.endsWith('notes.md') && (notes.text.match(/^## /gm) ?? []).length === exampleSlides, 'The notes file must have one section per shown slide.');
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

  // 15. A file with no deck opens on the start screen; its six templates fit the width.
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
  checks.push('start screen');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, errors, contrast: { light: light.ratio, dark: dark.ratio } };
  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
