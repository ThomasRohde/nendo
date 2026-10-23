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
  await command('slide.delete');
  await until(n => window.deck.slides.length === n, exampleSlides);
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
  await frame.click('#variants [data-use="dk.variant.v2"]');
  await until(() => document.querySelectorAll('#variants .variant').length === 0);
  const used = await record('dk.slide', askSlide);
  assert(used.values['dk.slide.layout'] === 'Statement' && used.values['dk.slide.kicker'] === 'The rule' && !used.values['dk.slide.image'],
    `Use must set the variant's slide fields, and only slide fields it may: ${JSON.stringify(used.values)}.`);
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
      return { name: window.deck.exports.at(-1).name, magic: bytes[0] === 0x50 && bytes[1] === 0x4b, names: entries.map(e => e.name), size: /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(presentation)?.slice(1) };
    }, name);
  };
  const pptx = await exported('export.pptx', 'pptx');
  const slideParts = pptx.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  const noteParts = pptx.names.filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length;
  assert(pptx.magic && pptx.name.endsWith('.pptx') && slideParts === exampleSlides && noteParts === exampleSlides && pptx.names.includes('[Content_Types].xml')
    && JSON.stringify(pptx.size) === JSON.stringify(['12192000', '6858000']), `The PowerPoint file must hold ${exampleSlides} slides with notes at 16:9: ${JSON.stringify({ slideParts, noteParts, size: pptx.size })}.`);
  const html = await exported('export.html', 'html');
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
  await page.evaluate(() => window.broker.remount());
  await page.waitForTimeout(300);
  frame = await mounted();
  await ready();
  await page.waitForFunction(id => window.broker.record('dk.slide', id)?.values['dk.slide.title'] === 'Kept from before', kept, { timeout: 5000 })
    .catch(async () => { throw Error(`Typing not saved when the frame ended must be saved when the view starts again: ${JSON.stringify((await record('dk.slide', kept))?.values['dk.slide.title'])}.`); });
  assert(await frame.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('deck.drafts.')).length) === 0, 'A draft that was saved must leave the device.');
  checks.push('typing kept over a remount');

  // 14. A file with no deck opens on the start screen; its six templates fit the width.
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
