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
    data.setData('text/html', '<meta charset="utf-8"><p><b>Pasted</b> words </p>');
    data.setData('text/plain', 'Pasted words ');
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
  // Escape ends the editing; the box is drawn as words again.
  await page.keyboard.press('Escape');
  const ended = await frame.evaluate(() => ({ session: window.deck.stageEditor(), editable: document.querySelectorAll('#stage [contenteditable="true"]').length }));
  assert(!ended.session?.field && ended.editable === 0, `Escape must end the editing: ${JSON.stringify(ended)}.`);
  // Smaller, pressed past the smallest size a slide keeps, stops there rather than going back to the layout's.
  await clickAt(TITLE, 2);
  for (let i = 0; i < 30; i++) await page.keyboard.press('Control+BracketLeft');
  const smallest = await frame.evaluate(() => ({ format: window.deck.slides.find(x => x.id === window.deck.slideId).format}));
  const titleScale = JSON.parse(smallest.format || '{}').title?.size;
  assert(titleScale >= 0.25 && titleScale < 0.35, `Smaller pressed many times must stop at the smallest size the slide keeps: ${JSON.stringify(smallest.format)}.`);
  await page.keyboard.press('Escape');
  // A card's heading and a table's cell are edited on their own; the rest of the line stays as it was.
  await openSlide(12);
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
  await openSlide(13);
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
  await page.keyboard.press('Control+z');
  await settle(300);
  // The deleted slide's changes are passed over; the one before them, on the Cards slide, is taken back.
  const after = await frame.evaluate(({ left, cards }) => ({ left: window.deck.slides.find(s => s.id === left), cards: window.deck.slides.find(s => s.id === cards).body.split('\n')[0], on: window.deck.slideId }), { left: left.id, cards: cards.id });
  assert(after.left.body === left.body && after.left.title === left.title && after.cards === '- KeyZnote | a dark stage and one bright accent' && after.on === cards.id,
    `Ctrl Z after the edited slide is deleted must change no other slide, and take back the last change on a slide still there: ${JSON.stringify({ was: left.body.slice(0, 50), now: after.left.body.slice(0, 50), cards: after.cards, on: after.on })}.`);
  checks.push('words edited on the stage');

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
  checks.push('start screen');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, errors, contrast: { light: light.ratio, dark: dark.ratio } };
  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
