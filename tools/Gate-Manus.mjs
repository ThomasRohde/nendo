async page => {
  // The Manuscript view (W-276) against the fixture broker: the real view API, Nendo's toolbar
  // rules, and writes checked as the Engine checks them. Run by Review-Manus.ps1.
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__BROKER_URL__');
  const manusFixture = '__MANUS_FIXTURE__';
  await page.evaluate(fixture => { window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.setFixture(fixture); }, manusFixture);
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  let frame = null;
  for (let i = 0; i < 200 && frame === null; i++) { frame = page.frames().find(f => f.url().startsWith(origin + '/')) ?? null; if (frame === null) await page.waitForTimeout(50); }
  assert(frame !== null, 'The Manuscript frame did not mount.');
  await frame.waitForFunction(() => window.manuscript?.root === 'b-root' && document.querySelector('.sheet-text [data-block="b-0415"]'), null, { timeout: 15000 });
  const checks = [];
  const BLOCK = 'mn.block', T = 'mn.block.text', K = 'mn.block.kind', P = 'mn.block.parent', O = 'mn.block.order';
  const record = (entity, id) => page.evaluate(({ entity, id }) => window.broker.record(entity, id), { entity, id });
  const records = entity => page.evaluate(entity => window.broker.records(entity), entity);
  const batches = () => page.evaluate(() => window.broker.requests.filter(r => r.m === 'records.batch').map(r => r.p));
  const saved = async () => {
    await frame.waitForFunction(() => window.manuscript.status.startsWith('Saved') && !window.manuscript.saving, null, { timeout: 8000 })
      .catch(async () => { throw Error(`The sheet did not save after [${checks.join(', ')}]: ${JSON.stringify(await frame.evaluate(() => ({ status: window.manuscript.status, problem: window.manuscript.problem, saving: !!window.manuscript.saving, timer: window.manuscript.timer })))}`); });
  };
  // Puts the caret (or a range) in a block by its text, through the editor's own selection, and
  // waits for the focus Tiptap gives on the next frame, so no keystroke lands before it.
  const select = (id, from, to = from) => frame.evaluate(({ id, from, to }) => {
    const sheet = window.manuscriptSheet, at = sheet.locate(id), text = at.node.textContent;
    const offset = where => where === 'end' ? at.node.content.size : typeof where === 'number' ? where : text.indexOf(where);
    sheet.editor.chain().focus().setTextSelection({ from: at.pos + 1 + offset(from), to: at.pos + 1 + offset(to) }).run();
  }, { id, from, to }).then(() => frame.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'), null, { timeout: 3000 }));
  const blockIds = () => frame.evaluate(() => [...document.querySelectorAll('.sheet-text [data-block]')].map(e => e.dataset.block));

  // Opening: the hierarchy reads as one continuous page, headings by kind, Cuttings left out.
  const opened = await frame.evaluate(() => ({
    h1: document.querySelector('.sheet-text h1')?.textContent, h2: [...document.querySelectorAll('.sheet-text h2')].map(e => e.textContent),
    em: document.querySelector('[data-block="b-0415"] em')?.textContent, blocks: [...document.querySelectorAll('.sheet-text [data-block]')].map(e => e.dataset.block),
    title: document.getElementById('title').value, overflow: document.documentElement.scrollWidth - innerWidth,
    marks: Object.fromEntries([...document.querySelectorAll('.mark')].map(m => [m.dataset.id, m.textContent])),
  }));
  assert(opened.h1 === 'Part One' && JSON.stringify(opened.h2) === JSON.stringify(['The Tide Table', 'What the Bar Keeps']), `Headings by kind: ${JSON.stringify(opened)}`);
  assert(opened.em === 'Boat seen beyond the bar. No lights. Did not report.', `Inline Markdown did not render: ${JSON.stringify(opened)}`);
  assert(!opened.blocks.includes('b-cuttings') && opened.blocks.length === 9 && opened.title === 'Low Water' && opened.overflow <= 1, `Opening sheet: ${JSON.stringify(opened)}`);
  // A block that is one picture is drawn as a picture; without Nendo's media methods it says it cannot be found.
  await frame.waitForFunction(() => document.querySelector('figure.picture[data-block="b-0502"] .picture-missing, figure.picture[data-block="b-0502"] img'), null, { timeout: 5000 })
    .catch(async () => { throw Error(`No picture is drawn for a block that is one picture: ${await frame.evaluate(() => document.querySelector('[data-block="b-0502"]')?.outerHTML ?? 'no block b-0502')}`); });
  const picture = await frame.evaluate(() => document.querySelector('figure.picture[data-block="b-0502"]').textContent);
  assert(picture === 'Picture not found: The causeway at low water', `Picture block: ${picture}`);
  assert(opened.marks['b-0415'] === '2' && opened.marks['b-0501'] === '1', `Gutter counts must match the notes and links: ${JSON.stringify(opened.marks)}`);
  assert((await page.evaluate(() => window.broker.chromeRefusals)).length === 0, 'Nendo refused the toolbar: ' + JSON.stringify(await page.evaluate(() => window.broker.chromeRefusals)));
  const toolbar = await page.evaluate(() => window.broker.toolbars.at(-1));
  assert(toolbar.items.some(i => i.id === 'style') && toolbar.items.some(i => i.id === 'outline') && toolbar.items.some(i => i.kind === 'text'), `Toolbar: ${JSON.stringify(toolbar)}`);
  assert((await batches()).length === 0, 'Opening the sheet wrote to the file.');
  checks.push('opens as one page', 'picture blocks', 'gutter counts', 'toolbar in Nendo');

  // Typing saves after a pause, as one batch that writes only that paragraph's text.
  await select('b-0414', 'end');
  await page.keyboard.type(' Then she opened it.');
  await saved();
  let all = await batches();
  assert(all.length === 1 && all[0].writes.length === 1 && all[0].writes[0].recordId === 'b-0414' && JSON.stringify(Object.keys(all[0].writes[0].values)) === JSON.stringify([T]),
    `Typing must write one paragraph's text in one batch: ${JSON.stringify(all)}`);
  assert((await record(BLOCK, 'b-0414')).values[T].endsWith('Then she opened it.'), 'The typed text was not stored.');
  checks.push('autosave on a pause, one paragraph');

  // Enter splits: the leading part keeps its ID, the rest is a new block in the same chapter, after it.
  await select('b-0416', 'Her grandfather');
  await page.keyboard.press('Enter');
  await saved();
  const afterSplit = await blockIds();
  const newId = afterSplit[afterSplit.indexOf('b-0416') + 1];
  const created = await record(BLOCK, newId), kept = await record(BLOCK, 'b-0416');
  assert(newId?.startsWith('b-') && created && created.values[P] === 'b-ch-3' && created.values[O] > kept.values[O] && created.values[T].startsWith('Her grandfather') && kept.values[T] === 'Agnes read it three times. ',
    `Split: ${JSON.stringify({ newId, created, kept })}`);
  checks.push('split keeps the leading ID');

  // Backspace at its start joins it back: the first keeps its ID and text, the second record is deleted.
  await select(newId, 0);
  await page.keyboard.press('Backspace');
  await saved();
  assert(await record(BLOCK, newId) === null && (await record(BLOCK, 'b-0416')).values[T].includes('three times. Her grandfather'), `Merge: ${JSON.stringify(await record(BLOCK, 'b-0416'))}`);
  checks.push('merge deletes the second block');

  // A paragraph made a Section takes the paragraphs after it in its chapter; made a paragraph again, they return.
  await select('b-0415', 3);
  await page.evaluate(() => window.broker.command('style', 'Section'));
  await saved();
  const section = await record(BLOCK, 'b-0415');
  assert(section.values[K] === 'Section' && section.values[P] === 'b-ch-3' && (await record(BLOCK, 'b-0416')).values[P] === 'b-0415' && (await record(BLOCK, 'b-0501')).values[P] === 'b-ch-4',
    `Section: ${JSON.stringify({ section, next: await record(BLOCK, 'b-0416') })}`);
  await page.evaluate(() => window.broker.command('style', 'Paragraph'));
  await saved();
  assert((await record(BLOCK, 'b-0415')).values[K] === 'Paragraph' && (await record(BLOCK, 'b-0416')).values[P] === 'b-ch-3', 'Making it a paragraph again did not give its paragraphs back to the chapter.');
  checks.push('headings hold what follows them');

  // The selected-paragraph bar: a note, then a link.
  await select('b-0414', 'ledger', 'shelf');
  await frame.getByRole('toolbar', { name: 'This paragraph' }).waitFor({ timeout: 3000 });
  await frame.getByRole('button', { name: 'Note', exact: true }).click();
  await frame.getByLabel('Note', { exact: true }).fill('Count the hands again.');
  await frame.getByRole('button', { name: 'Add note' }).click();
  await frame.waitForFunction(() => window.manuscript.notes.length === 2);
  const note = (await records('mn.note')).find(n => n.recordId !== 'n-1');
  assert(note.values['mn.note.block'] === 'b-0414' && note.values['mn.note.text'] === 'Count the hands again.', `Note: ${JSON.stringify(note)}`);
  await select('b-0413', 'tide', 'table');
  await frame.getByRole('button', { name: 'Link', exact: true }).click();
  await frame.getByLabel('Find a passage').fill('causeway');
  await frame.getByRole('listitem').filter({ hasText: 'The causeway was dry' }).click();
  await frame.waitForFunction(() => window.manuscript.links.length === 2);
  const link = (await records('mn.link')).find(l => l.recordId !== 'l-1');
  assert(link.values['mn.link.from'] === 'b-0413' && link.values['mn.link.to'] === 'b-0501', `Link: ${JSON.stringify(link)}`);
  checks.push('note and link from the bar');

  // Keep as cutting: the paragraph leaves the page for the Cuttings, links and all.
  await select('b-0413', 'tide', 'table');
  await frame.getByRole('button', { name: 'Keep as cutting' }).click();
  await frame.waitForFunction(() => !document.querySelector('.sheet-text [data-block="b-0413"]'));
  await saved().catch(() => undefined);
  await page.waitForTimeout(1600);
  const cut = await record(BLOCK, 'b-0413');
  assert(cut && cut.values[P] === 'b-cuttings' && (await records('mn.link')).some(l => l.values['mn.link.from'] === 'b-0413'), `Cutting: ${JSON.stringify(cut)}`);
  checks.push('keep as cutting');

  // Deleting a paragraph with a note deletes both in one batch.
  await frame.evaluate(() => { const s = window.manuscriptSheet, at = s.locate('b-0414'); s.editor.chain().focus().deleteRange({ from: at.pos, to: at.pos + at.node.nodeSize }).run(); });
  await saved();
  all = await batches();
  const last = all.at(-1).writes.map(w => `${w.op}:${w.recordId}`);
  assert(await record(BLOCK, 'b-0414') === null && !(await records('mn.note')).some(n => n.values['mn.note.block'] === 'b-0414') && last.includes('delete:b-0414'), `Delete with its note: ${JSON.stringify(last)}`);
  checks.push('removal takes its notes');

  // A stale write is refused, said, and not forced; Reload takes the saved version.
  const before = (await record(BLOCK, 'b-0501')).values[T];
  await page.evaluate(() => window.broker.touch('mn.block', 'b-0501'));
  await select('b-0501', 'end');
  await page.keyboard.type(' Too late.');
  await frame.waitForFunction(() => window.manuscript.status === 'Not saved', null, { timeout: 8000 });
  const problem = await frame.evaluate(() => document.getElementById('problem').textContent);
  assert(/Not saved/.test(problem) && (await record(BLOCK, 'b-0501')).values[T] === before, `Stale write: ${problem}`);
  await frame.getByRole('button', { name: 'Reload' }).click();
  await frame.waitForFunction(text => document.querySelector('[data-block="b-0501"]').textContent === text && document.getElementById('problem').hidden, before);
  checks.push('stale write refused, then reload');

  // Somebody else's change reloads the page when nothing is waiting to be saved.
  const other = await record(BLOCK, 'b-0501');
  await page.evaluate(r => { window.broker.put('mn.block', { ...r, version: r.version + 1, values: { ...r.values, 'mn.block.text': 'The causeway was dry by half past four.' } }); window.broker.pushChanges(); }, other);
  await frame.waitForFunction(() => document.querySelector('[data-block="b-0501"]').textContent === 'The causeway was dry by half past four.', null, { timeout: 5000 });
  checks.push('external change reloads');

  // Text not yet saved outlasts the view: refused twice, then the view is stopped and started again.
  await page.evaluate(() => window.broker.fail('records.batch', { code: 'host-timeout', message: 'The Desktop host did not respond.' }, 2));
  await select('b-0501', 'end');
  await page.keyboard.type(' The posts were numbered.');
  await frame.waitForFunction(() => window.manuscript.status === 'Not saved', null, { timeout: 8000 });
  await page.waitForTimeout(400);
  const beforeRemount = await frame.evaluate(() => ({ text: document.querySelector('[data-block="b-0501"]').textContent, draft: localStorage.getItem(`manuscript.draft.v1.${window.nendo.context.viewId}`)?.length, status: window.manuscript.status }));
  await page.evaluate(() => window.broker.remount());
  let restarted = null;
  for (let i = 0; i < 200 && restarted === null; i++) { restarted = page.frames().find(f => f.url().startsWith(origin + '/') && f !== frame) ?? null; if (restarted === null) await page.waitForTimeout(50); }
  assert(restarted !== null, 'The view did not start again.');
  frame = restarted;
  await frame.waitForFunction(() => window.manuscript?.status?.startsWith('Saved'), null, { timeout: 10000 })
    .catch(async () => { throw Error(`The kept text was not saved after a restart: ${JSON.stringify(await frame.evaluate(() => ({ status: window.manuscript?.status, problem: window.manuscript?.problem })))}`); });
  assert((await record(BLOCK, 'b-0501')).values[T].endsWith('The posts were numbered.'), `Kept draft: ${JSON.stringify({ stored: await record(BLOCK, 'b-0501'), beforeRemount, batches: (await batches()).slice(-3) })}`);
  checks.push('unsaved text outlasts the view');

  // Light and Dark, and a narrow frame.
  const colours = {};
  for (const mode of ['light', 'dark']) {
    await page.evaluate(m => window.broker.pushTheme(m), mode);
    await page.waitForTimeout(150);
    colours[mode] = await frame.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.querySelector('.sheet-text')).color }));
    await select('b-0415', 'pencil', 'line');
    await page.waitForTimeout(100);
    await page.screenshot({ path: '__OUTPUT__/' + mode + '.png' });
  }
  assert(colours.light.background !== colours.dark.background && colours.light.ink !== colours.dark.ink, `Theme: ${JSON.stringify(colours)}`);
  await page.setViewportSize({ width: 620, height: 900 }); await page.waitForTimeout(150);
  const narrow = await frame.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, bar: document.querySelector('.bar')?.getBoundingClientRect().right, width: innerWidth }));
  assert(narrow.overflow <= 1 && (narrow.bar === undefined || narrow.bar <= narrow.width + 1), `Narrow: ${JSON.stringify(narrow)}`);
  checks.push('Light/Dark', 'narrow layout');
  assert(!(await batches()).some(b => b.writes.some(w => w.recordId === 'b-0502')), 'An edit elsewhere rewrote the picture block.');
  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, colours, narrow, errors };
}
