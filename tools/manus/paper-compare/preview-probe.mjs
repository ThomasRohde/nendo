async page => {
  // The paper preview of a snapshot, in the real view against the fixture broker: each sheet's
  // lines (left and right edges, exact baseline, size, words) in points, and a picture of each
  // sheet at its own size. Written into a probe by preview-fixture.mjs.
  const out = { complete: false };
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.goto('__BROKER_URL__');
  const fixture = '__FIXTURE__';
  const media = '__MEDIA__';
  const root = '__ROOT__';
  await page.evaluate(({ fixture, media }) => { window.broker.offerChrome(true); window.broker.offerMedia(media); window.broker.setFixture(fixture); }, { fixture, media });
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  let frame = null;
  for (let i = 0; i < 200 && frame === null; i++) { frame = page.frames().find(f => f.url().startsWith(origin + '/')) ?? null; if (frame === null) await page.waitForTimeout(50); }
  if (!frame) throw Error('The view did not mount.');
  await frame.waitForFunction(() => Boolean(window.manuscript?.root), null, { timeout: 20000 });
  if (root) {
    await page.evaluate(id => window.broker.command('manuscript', id), root);
    await frame.waitForFunction(id => window.manuscript.root === id, root, { timeout: 20000 });
  }
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.evaluate(() => window.broker.command('mode', 'paper'));
  await frame.waitForFunction(() => document.getElementById('preview').dataset.layout === 'paper' && document.querySelectorAll('.sheet-page').length > 0, null, { timeout: 30000 })
    .catch(() => { throw Error(`No paper sheets: ${JSON.stringify(errors)}`); });
  await frame.waitForFunction(() => [...document.querySelectorAll('.pv-picture img')].every(img => img.complete && img.naturalHeight > 0), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  // Each sheet at its own size, whatever the view's zoom does after a resize.
  await frame.evaluate(() => { document.getElementById('preview').style.setProperty('--zoom', '1'); document.querySelectorAll('.sheet-page').forEach(s => { s.style.zoom = '1'; }); });
  await page.waitForTimeout(300);
  out.pages = await frame.evaluate(() => [...document.querySelectorAll('.sheet-page')].map(sheet => {
    const s = sheet.getBoundingClientRect();
    const frags = [];
    const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const style = getComputedStyle(node.parentElement);
      // A paragraph carried on is cut by its piece: only the lines inside the piece are seen.
      const clip = node.parentElement.closest('.pv-piece')?.getBoundingClientRect() ?? null;
      const range = document.createRange(), re = /\S+/g;
      for (let m; (m = re.exec(node.textContent));) {
        range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
        let first = true;
        for (const r of range.getClientRects()) {
          if (r.width === 0) continue;
          const middle = (r.top + r.bottom) / 2;
          // A word broken across lines gives a rect per line: its text goes with the first.
          if (!clip || (middle >= clip.top && middle <= clip.bottom))
            frags.push({ x0: r.left - s.left, x1: r.right - s.left, top: r.top - s.top, size: parseFloat(style.fontSize), word: first ? m[0].replace(/­/g, '') : '', node, index: first ? m.index : null, font: style.fontFamily.split(',')[0].replace(/['"]/g, '') });
          first = false;
        }
      }
    }
    // Lines: consecutive words in reading order whose tops agree.
    const lines = [];
    for (const f of frags) {
      const last = lines.at(-1);
      if (last && Math.abs(last.top - f.top) < 3 && f.x0 >= last.x1 - 1 && f.x0 - last.x1 < 40) { last.x1 = f.x1; if (f.word) last.text += ' ' + f.word; if (last.index === null && f.index !== null) { last.node = f.node; last.index = f.index; } }
      else lines.push({ ...f, text: f.word });
    }
    // The exact baseline: a zero-sized inline block before the line's first word stands on it.
    // Inserted from the last line back, so splitting a text never moves a later line's place.
    const marks = [];
    for (const l of [...lines].reverse()) {
      if (l.index === null) continue;
      const mark = document.createElement('span');
      mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      l.node.splitText(l.index).before(mark);
      marks.push([l, mark]);
    }
    for (const [l, mark] of marks) l.base = mark.getBoundingClientRect().bottom - s.top;
    for (const [, mark] of marks) { const parent = mark.parentNode; mark.remove(); parent.normalize(); }
    const pt = v => Math.round(v * 0.75 * 10) / 10;
    return { w: pt(s.width), h: pt(s.height), lines: lines.filter(l => l.base !== undefined).map(l => ({ x0: pt(l.x0), x1: pt(l.x1), base: pt(l.base), size: pt(l.size), font: l.font, text: l.text })) };
  }));
  // Each sheet scrolled to the top of the frame and cut out of the page by its own rectangle.
  const frameBox = await (await frame.frameElement()).boundingBox();
  const count = await frame.evaluate(() => document.querySelectorAll('.sheet-page').length);
  for (let i = 0; i < count; i++) {
    const r = await frame.evaluate(n => { const s = document.querySelectorAll('.sheet-page')[n]; s.scrollIntoView({ block: 'start' }); const b = s.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }, i);
    await page.waitForTimeout(100);
    await page.screenshot({ path: `__OUTPUT__/preview-${i + 1}.png`, clip: { x: frameBox.x + r.x, y: frameBox.y + r.y, width: r.width, height: r.height } });
  }
  out.errors = errors;
  out.complete = true;
  return JSON.stringify(out);
}
