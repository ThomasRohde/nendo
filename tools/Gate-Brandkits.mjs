async page => {
  // The Brandkits view in the fixture broker: the Slides tile and the Deck design export, measured
  // where the person meets them. tools/Review-Brandkits.ps1 fills the placeholders and runs this with
  // playwright-cli. A failure names the last check that passed.
  const checks = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`Browser dialog (${dialog.type()}): ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__BROKER_URL__');
  const fixture = '__BRANDKITS_FIXTURE__';
  await page.waitForFunction(() => window.broker && window.toolbarRules);
  await page.evaluate(fixture => {
    window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.offerPlaces(true); window.broker.offerMediaPut(true);
    window.broker.offerAssistant({ state: 'ready', name: 'Agent', working: false, access: 'always' });
    window.broker.setFixture(fixture);
  }, fixture);
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find(f => f.url().startsWith(origin + '/')) ?? null; if (!frame) await page.waitForTimeout(50); }
  assert(frame, 'The Brandkits frame did not mount.');
  const until = (fn, arg, ms = 8000) => frame.waitForFunction(fn, arg, { timeout: ms });
  const kitId = fixture.records.kit[0].recordId;
  const kit = () => page.evaluate(id => window.broker.record('kit', id), kitId);
  const choices = async () => JSON.parse((await kit()).values.kitSlides ?? '{}');
  const command = (id, value = null) => page.evaluate(({ id, value }) => window.broker.command(id, value), { id, value });

  // 1. The board draws the kit, and under it the Slides tile: four slides Deck's engine drew.
  await until(() => document.querySelector('.bento') && document.querySelectorAll('.t-slides .slide-shot .dk-slide').length === 4, null, 15000)
    .catch(() => { throw Error('The Slides tile never showed four slides drawn by the Deck engine: a module of the package failed to load, or the tile is missing.'); });
  // The tile scales a drawn slide to its box a frame later; measure once it has, and let the
  // assertion below name a slide that never fills it.
  await until(() => { const shot = document.querySelector('.t-slides .slide-shot'), slide = shot?.firstElementChild;
    return !!slide && Math.abs(slide.getBoundingClientRect().width - shot.getBoundingClientRect().width) < 2; }, null, 4000).catch(() => {});
  const first = await frame.evaluate(() => {
    const shot = document.querySelector('.t-slides .slide-shot'), slide = shot.firstElementChild;
    const box = shot.getBoundingClientRect(), drawn = slide.getBoundingClientRect();
    return { family: document.querySelector('[data-slide-choice="family"]').value, width: box.width, drawn: drawn.width, height: box.height, ratio: box.width / box.height,
      text: [...shot.querySelectorAll('.dk-t')].map(t => t.textContent).join(' ') };
  });
  // Ember & Oak is "Warm, Crafted, Plain-spoken, Unhurried": Editorial, until the person picks another.
  assert(first.family === 'editorial', `A kit with no slide choices must start on the family its personality suggests: ${first.family}.`);
  assert(Math.abs(first.ratio - 16 / 9) < 0.02 && Math.abs(first.drawn - first.width) < 2 && first.width > 200, `Each slide must fill its 16:9 box: ${JSON.stringify(first)}.`);
  assert(first.text.includes(fixture.records.kit[0].values.kitTagline), 'The title slide must carry the kit\'s tagline.');
  // A web font that arrives after the slides were fitted with the fallback's widths draws them again.
  await frame.evaluate(() => { document.querySelector('.t-slides').dataset.drawn = 'before'; document.fonts.dispatchEvent(new Event('loadingdone')); });
  await until(() => document.querySelector('.t-slides') && document.querySelector('.t-slides').dataset.drawn !== 'before' && document.querySelectorAll('.t-slides .dk-slide').length === 4, null, 4000)
    .catch(() => { throw Error('When a web font has loaded, the slides must be measured and drawn again.'); });
  // The tile's grid goes to two columns below 1000 pixels: every slide is scaled to its new box.
  await page.setViewportSize({ width: 900, height: 900 });
  const resized = await until(() => [...document.querySelectorAll('.t-slides .slide-shot')].every(box => Math.abs(box.firstElementChild.getBoundingClientRect().width - box.getBoundingClientRect().width) < 2), null, 4000)
    .then(() => true).catch(() => false);
  const sizes = await frame.evaluate(() => [...document.querySelectorAll('.t-slides .slide-shot')].map(box => [Math.round(box.getBoundingClientRect().width), Math.round(box.firstElementChild.getBoundingClientRect().width)]));
  assert(resized, `A slide must fill its box again when the window narrows: ${JSON.stringify(sizes)} (box, slide).`);
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('slides drawn');

  // 2. A choice is written to the kit as one step, and the slides are drawn again with it.
  const pick = async (key, value) => {
    await frame.selectOption(`[data-slide-choice="${key}"]`, value);
  };
  const written = (test, message) => page.waitForFunction(({ id, test }) => (0, eval)(test)(JSON.parse(window.broker.record('kit', id).values.kitSlides ?? '{}')), { id: kitId, test: String(test) }, { timeout: 8000 })
    .catch(() => page.evaluate(id => window.broker.record('kit', id).values.kitSlides ?? '{}', kitId).then(now => { throw Error(`${message} The kit's slide choices: ${now}.`); }));
  await pick('family', 'studio');
  await written(c => c.family === 'studio', 'Choosing the Studio family must write it to the kit.');
  await until(() => document.querySelector('[data-slide-choice="family"]').value === 'studio');
  await pick('bg:title', 'role:secondary');
  await written(c => c.backgrounds?.title === 'role:secondary', 'Choosing Secondary behind the title slides must write it to the kit.');
  const secondary = fixture.records.colour.find(c => c.values.colourRole === 'Secondary').values.colourHex;
  const titleBack = await until(hex => {
    const slide = document.querySelector('.t-slides .slide-shot .dk-slide');
    const rgb = hex.match(/[0-9a-f]{2}/gi).map(h => parseInt(h, 16)).join(', ');
    return slide && getComputedStyle(slide).backgroundColor === `rgb(${rgb})`;
  }, secondary).then(() => true).catch(() => false);
  assert(titleBack, `The title slide must be drawn on the kit's Secondary (${secondary}) once it is chosen.`);
  await pick('placement', 'bottom-left');
  await pick('radius', '12');
  // Two choices in quick succession: the second must not be refused for the version the first changed.
  await written(c => c.placement === 'bottom-left' && c.radius === 12, 'Two choices made one after the other must both reach the kit.');
  const batches = await page.evaluate(() => window.broker.requests.filter(r => r.m === 'records.batch').map(r => ({ label: r.p.label, offerUndo: r.p.offerUndo })));
  assert(batches.length >= 4 && batches.every(b => b.offerUndo === true && /^Slides: /.test(b.label)), `Each slide choice must be one batch Nendo offers to undo: ${JSON.stringify(batches)}.`);
  checks.push('choices written');

  // 3. A picture behind a kind of slide is asked for first, put in the kit's field for it, then chosen.
  // A real file chooser is a modal that stops playwright-cli's run-code, so the view's click on its
  // picture input is counted instead, and the file is set on that input as the chooser would.
  await frame.evaluate(() => {
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { if (this.type === 'file') { window.__fileAsked = (window.__fileAsked ?? 0) + 1; return; } return click.call(this); };
  });
  await pick('bg:section', 'picture');
  await until(() => window.__fileAsked === 1).catch(() => { throw Error('Choosing a picture behind the section slides must ask for its file first.'); });
  // Made in the page: playwright-cli's run-code has no Node Buffer for setInputFiles.
  await frame.evaluate(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const input = document.querySelector('input[type="file"][accept^="image/png"]');
    const files = new DataTransfer();
    files.items.add(new File([png], 'harbour.png', { type: 'image/png' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await written(c => c.backgrounds?.section === 'picture', 'A picture put behind the section slides must be chosen once it is in the kit.');
  const put = await page.evaluate(() => window.broker.requests.filter(r => r.m === 'media.put' && r.p.base64 === undefined).map(r => ({ fieldId: r.p.fieldId, name: r.p.name, entityId: r.p.entityId })));
  assert(put.length === 1 && put[0].fieldId === 'kitSlideSection' && put[0].entityId === 'kit' && put[0].name === 'harbour.png', `The picture must be put once, into the kit's Section slide picture: ${JSON.stringify(put)}.`);
  checks.push('picture background');

  // 4. Export → Deck design downloads one .deckdesign that Deck's reader takes, with the choices made here.
  await frame.evaluate(() => {
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { window.__lastBlob = blob; return make(blob); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__lastName = this.download; return click.call(this); };
  });
  const toolbar = await page.evaluate(() => JSON.stringify(window.broker.toolbar ?? window.broker.lastToolbar ?? null));
  assert(!toolbar || toolbar === 'null' || toolbar.includes('export-deck-design'), 'The Export menu must offer the Deck design.');
  // A choice still being written when Export is chosen belongs in the file: Nendo answers its write late.
  await page.evaluate(() => window.broker.hold('records.batch', 1500, 1));
  await pick('mode', 'dark');
  await command('export-deck-design');
  await until(() => window.__lastName?.endsWith('.deckdesign'));
  const exported = await frame.evaluate(async () => {
    const { readDesignPackage } = await import('./deck/design.mjs');
    const { design, pictures } = await readDesignPackage(new Uint8Array(await window.__lastBlob.arrayBuffer()), window.__lastName);
    return { name: window.__lastName, design, pictures: [...pictures.keys()].sort() };
  });
  const d = exported.design;
  assert(d.template.mode === 'dark', `The export must wait for the choice still being written (a dark stage): ${d.template.mode}.`);
    assert(exported.name === 'Example Ember & Oak.deckdesign', `The file must be named for the kit: ${exported.name}.`);
  assert(d.template.family === 'studio' && d.template.style.radius === 12 && d.logos.placement === 'bottom-left' && d.backgrounds.title.role === 'secondary',
    `The design must carry the choices made on the Slides tile: ${JSON.stringify({ template: d.template, logos: d.logos, backgrounds: d.backgrounds })}.`);
  assert(d.source.app === 'Brandkits' && d.source.kit === kitId && d.colors.primary && d.fonts.heading, `The design must name its kit and carry its roles and fonts: ${JSON.stringify(d.source)}.`);
  assert(exported.pictures.includes('logos/logo.svg') && exported.pictures.includes('logos/mark.svg'), `The design must carry the kit's logo and mark: ${JSON.stringify(exported.pictures)}.`);
  checks.push('deck design export');

  // 5. The Contrast tile counts the words on a sample's button, not only the button on its card. A
  // grey accent passes 3:1 as a button on cream, but neither cream nor espresso reads at 4.5:1 on it.
  await page.evaluate(() => {
    const caramel = window.broker.record('colour', 'c-ex-caramel');
    window.broker.put('colour', { ...caramel, version: caramel.version + 1, values: { ...caramel.values, colourHex: '#777777' } });
    window.broker.pushChanges();
  });
  const pairs = await until(() => /fail AA/.test(document.querySelector('.t-contrast .summary')?.textContent ?? ''), null, 4000)
    .then(() => null).catch(() => frame.evaluate(() => document.querySelector('.t-contrast')?.textContent));
  assert(pairs === null, `A button label that fails AA on its button must count among the failing pairs: ${pairs}.`);
  checks.push('button label contrast');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, errors };
  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
