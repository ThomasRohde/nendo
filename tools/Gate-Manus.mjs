async page => {
  // Every failure names the checks that passed before it, so a bare timeout says where it was.
  const checks = [];
  try { return await (async () => {
  // The Manuscript view (W-276) against the fixture broker: the real view API, Nendo's toolbar
  // rules, and writes checked as the Engine checks them. Run by Review-Manus.ps1.
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__BROKER_URL__');
  const manusFixture = '__MANUS_FIXTURE__';
  await page.evaluate(fixture => { window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.offerPlaces(true); window.broker.setFixture(fixture); }, manusFixture);
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  let frame = null;
  for (let i = 0; i < 200 && frame === null; i++) { frame = page.frames().find(f => f.url().startsWith(origin + '/')) ?? null; if (frame === null) await page.waitForTimeout(50); }
  assert(frame !== null, 'The Manuscript frame did not mount.');
  await frame.waitForFunction(() => window.manuscript?.root === 'b-root' && document.querySelector('.sheet-text [data-block="b-0415"]'), null, { timeout: 15000 });
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
  // While writing a picture is a thumbnail; Full width under Appearance gives it the column.
  const pictureBox = () => frame.evaluate(() => { const r = document.querySelector('figure.picture[data-block="b-0502"] .picture-missing').getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; });
  const thumbnail = await pictureBox();
  assert(thumbnail.width === 168 && thumbnail.height === 112, `A picture must open as a 168 by 112 thumbnail, not ${JSON.stringify(thumbnail)}`);
  await page.evaluate(() => window.broker.command('pictures', 'full'));
  await frame.waitForFunction(() => document.documentElement.dataset.pictures === 'full');
  const full = await pictureBox();
  assert(full.width > 500 && Math.abs(full.height - full.width * 2 / 3) <= 2, `Full width: ${JSON.stringify(full)}`);
  await page.evaluate(() => window.broker.command('pictures', 'small'));
  await frame.waitForFunction(() => document.documentElement.dataset.pictures === 'small');
  assert(opened.marks['b-0415'] === '2' && opened.marks['b-0501'] === '1', `Gutter counts must match the notes and links: ${JSON.stringify(opened.marks)}`);
  assert((await page.evaluate(() => window.broker.chromeRefusals)).length === 0, 'Nendo refused the toolbar: ' + JSON.stringify(await page.evaluate(() => window.broker.chromeRefusals)));
  const toolbar = await page.evaluate(() => window.broker.toolbars.at(-1));
  assert(toolbar.items.some(i => i.id === 'style') && toolbar.items.some(i => i.id === 'outline') && toolbar.items.some(i => i.kind === 'text'), `Toolbar: ${JSON.stringify(toolbar)}`);
  assert((await batches()).length === 0, 'Opening the sheet wrote to the file.');
  checks.push('opens as one page', 'picture blocks', 'pictures as thumbnails', 'gutter counts', 'toolbar in Nendo');

  // Several manuscripts in one file: the picker opens another as a step in Back and Forward, Back
  // returns without a new step, and New manuscript starts a third and opens it.
  const picker = (await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(i => i.id === 'manuscript');
  assert(picker && picker.options.map(o => o.value).join() === 'b-root,b-root-2,new' && picker.options[1].label === 'Field Notes', `Manuscript picker: ${JSON.stringify(picker)}`);
  await page.evaluate(() => window.broker.command('manuscript', 'b-root-2'));
  await frame.waitForFunction(() => document.querySelector('.sheet-text [data-block="b-fn-2"]') && !document.querySelector('.sheet-text [data-block="b-0413"]') && document.getElementById('title').value === 'Field Notes', null, { timeout: 5000 });
  const stepped = await page.evaluate(() => window.broker.places.at(-1));
  assert(stepped.place.manuscript === 'b-root-2' && stepped.replace === false && stepped.label === 'Field Notes', `The switch was not a step: ${JSON.stringify(stepped)}`);
  const placesBefore = await page.evaluate(() => window.broker.places.length);
  await page.evaluate(() => window.broker.pushPlace({ manuscript: 'b-root' }));
  await frame.waitForFunction(() => document.querySelector('.sheet-text [data-block="b-0413"]') && document.getElementById('title').value === 'Low Water', null, { timeout: 5000 });
  assert(await page.evaluate(n => window.broker.places.slice(n).every(p => p.replace), placesBefore), 'Back made a new step: ' + JSON.stringify(await page.evaluate(n => window.broker.places.slice(n), placesBefore)));
  await page.evaluate(() => window.broker.command('manuscript', 'new'));
  await frame.waitForFunction(() => window.manuscript.manuscripts?.length === 3 && document.getElementById('title').value === 'Untitled manuscript', null, { timeout: 5000 });
  const roots = (await records(BLOCK)).filter(r => r.values[K] === 'Manuscript' && !r.values[P]);
  assert(roots.length === 3 && roots.some(r => r.values[T] === 'Untitled manuscript'), `Roots: ${JSON.stringify(roots.map(r => r.recordId))}`);
  await page.evaluate(() => window.broker.pushPlace({ manuscript: 'b-root' }));
  await frame.waitForFunction(() => document.querySelector('.sheet-text [data-block="b-0413"]'), null, { timeout: 5000 });
  checks.push('several manuscripts, Back and Forward');

  // Export reads the saved manuscript and downloads it; a picture it cannot read is named, not dropped.
  const exported = async (command, name) => {
    const waiting = page.waitForEvent('download', { timeout: 15000 });
    await page.evaluate(id => window.broker.command(id), command);
    const download = await waiting.catch(async () => { throw Error(`No download for ${command}: ${JSON.stringify(await frame.evaluate(() => ({ status: window.manuscript.status, problem: window.manuscript.problem, last: window.manuscript.lastExport })))}`); });
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((at, c) => { bytes.set(c, at); return at + c.length; }, 0);
    assert(download.suggestedFilename() === name, `Export ${command} saved ${download.suggestedFilename()}, not ${name}`);
    return bytes;
  };
  const exportMenu = (await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(i => i.id === 'export');
  assert(exportMenu && exportMenu.items.map(i => i.id).join() === 'export-markdown,export-word,export-word-paper', `Export menu: ${JSON.stringify(exportMenu)}`);
  // The probe's sandbox has no TextDecoder; the page decodes the bytes.
  const markdownBytes = await exported('export-markdown', 'Low Water.md');
  const markdown = await page.evaluate(bytes => new TextDecoder().decode(new Uint8Array(bytes)), Array.from(markdownBytes));
  assert(markdown.startsWith(['# Low Water', '## Part One', '### The Tide Table', ''].join('\n\n')) && markdown.includes('*Boat seen beyond the bar. No lights. Did not report.*')
    && markdown.includes('![The causeway at low water](media:') && !markdown.includes('Cuttings'), `Markdown export: ${markdown.slice(0, 400)}`);
  await frame.waitForFunction(() => /could not go in/.test(document.getElementById('problem').textContent));
  const word = await exported('export-word', 'Low Water.docx');
  assert(word[0] === 0x50 && word[1] === 0x4b && word.length > 4000, `Word export is not a .docx package: ${word.length} bytes`);
  const report = await frame.evaluate(() => window.manuscript.lastExport);
  assert(report.format === 'word' && report.layout === 'book' && report.missing.length === 1 && report.pictures === 1, `Export report: ${JSON.stringify(report)}`);
  const paper = await exported('export-word-paper', 'Low Water.docx');
  assert(paper[0] === 0x50 && paper[1] === 0x4b && (await frame.evaluate(() => window.manuscript.lastExport.layout)) === 'paper', 'The paper layout did not export.');
  checks.push('Markdown and Word export');

  // Preview: Book and Paper draw the manuscript on sheets of their layout; Write comes back to the editor.
  const mode = m => page.evaluate(v => window.broker.command('mode', v), m);
  await mode('book');
  await frame.waitForFunction(() => !document.getElementById('preview').hidden && document.getElementById('page').hidden && document.querySelectorAll('.sheet-page').length > 1, null, { timeout: 5000 });
  const book = await frame.evaluate(() => ({ pages: document.querySelectorAll('.sheet-page').length, width: Math.round(document.querySelector('.sheet-page').getBoundingClientRect().width),
    chapterTop: [...document.querySelectorAll('.sheet-page')].findIndex(p => p.querySelector('.pv-h1')?.textContent === 'Part One') }));
  // At Medium the sheet is scaled so its 432-pixel text column shows at 760 pixels.
  assert(Math.abs(book.width - Math.round(576 * 760 / 432)) <= 2 && book.pages >= 3 && book.chapterTop >= 1, `Book preview: ${JSON.stringify(book)}`);
  // The API sends at most one declaration a tenth of a second, so the preview's arrives a moment later.
  await page.waitForFunction(() => !window.broker.toolbars.at(-1).items.some(i => i.id === 'style'), null, { timeout: 3000 })
    .catch(() => { throw Error('Writing controls stayed in the toolbar during preview.'); });
  await page.screenshot({ path: '__OUTPUT__/preview-book.png' });
  await mode('paper');
  await frame.waitForFunction(() => document.getElementById('preview').dataset.layout === 'paper');
  const paperPreview = await frame.evaluate(() => ({ width: Math.round(document.querySelector('.sheet-page').getBoundingClientRect().width), caption: !!document.querySelector('.pv-figure') }));
  assert(Math.abs(paperPreview.width - Math.round(816 * 760 / 672)) <= 2, `Paper preview: ${JSON.stringify(paperPreview)}`);
  // An article as arXiv carries one (AASTeX): the body in two columns side by side under the title
  // block, the draft line at the top of the first page, headings numbered in capitals.
  const article = await frame.evaluate(() => {
    const columns = [...document.querySelectorAll('.sheet-page')[0].querySelectorAll('.pv-columns > .pv-column')];
    const box = e => e.getBoundingClientRect();
    return { columns: columns.length, sideBySide: columns.length === 2 && Math.abs(box(columns[0]).top - box(columns[1]).top) < 1 && box(columns[1]).left > box(columns[0]).right,
      bodyInColumn: Boolean(columns[0]?.querySelector('h2, .pv-p')), running: document.querySelector('.sheet-page .running')?.textContent ?? null,
      heading: columns[0]?.querySelector('h2')?.textContent ?? null };
  });
  assert(article.columns === 2 && article.sideBySide && article.bodyInColumn && /^Draft version /.test(article.running ?? '') && /^\d+\. [A-Z ]+$/.test(article.heading ?? ''),
    `Paper preview is not two columns as AASTeX sets them: ${JSON.stringify(article)}`);
  await page.screenshot({ path: '__OUTPUT__/preview-paper.png' });
  // Line length scales the sheets: Narrow shows the text column at 620 pixels, Full fits the frame.
  await page.evaluate(() => window.broker.command('width', 'narrow'));
  const narrowSheet = await frame.evaluate(() => Math.round(document.querySelector('.sheet-page').getBoundingClientRect().width));
  // Text size scales them again, as it scales the writing sheet's type: 17, 19 or 22 pixels.
  const sized = {};
  for (const size of ['small', 'large', 'medium']) {
    await page.evaluate(value => window.broker.command('size', value), size);
    sized[size] = await frame.evaluate(() => Math.round(document.querySelector('.sheet-page').getBoundingClientRect().width));
  }
  assert(Math.abs(sized.small - Math.round(narrowSheet * 17 / 19)) <= 2 && Math.abs(sized.large - Math.round(narrowSheet * 22 / 19)) <= 2 && sized.medium === narrowSheet,
    `Preview text size: ${JSON.stringify({ narrowSheet, ...sized })}`);
  await page.evaluate(() => window.broker.command('width', 'full'));
  const fullSheet = await frame.evaluate(() => ({ sheet: Math.round(document.querySelector('.sheet-page').getBoundingClientRect().width), frame: innerWidth }));
  assert(Math.abs(narrowSheet - Math.round(816 * 620 / 672)) <= 2 && fullSheet.sheet >= fullSheet.frame - 60 && fullSheet.sheet <= fullSheet.frame, `Preview line length: narrow ${narrowSheet}, full ${JSON.stringify(fullSheet)}`);
  await page.evaluate(() => window.broker.command('width', 'medium'));
  await mode('write');
  await frame.waitForFunction(() => document.getElementById('preview').hidden && !document.getElementById('page').hidden);
  // Full line length: the text takes the frame's width, less the page's margins.
  await page.evaluate(() => window.broker.command('width', 'full'));
  await frame.waitForFunction(() => document.documentElement.dataset.width === 'full');
  const fullLine = await frame.evaluate(() => ({ text: Math.round(document.querySelector('.sheet-text').getBoundingClientRect().width), frame: innerWidth }));
  assert(fullLine.text > fullLine.frame - 160, `Full width: ${JSON.stringify(fullLine)}`);
  await page.evaluate(() => window.broker.command('width', 'medium'));
  checks.push('Book and Paper preview', 'paper in two columns', 'full line length', 'preview text size');

  // Typing saves after a pause, as one batch that writes only that paragraph's text.
  const typedFrom = (await batches()).length;
  await select('b-0414', 'end');
  await page.keyboard.type(' Then she opened it.');
  await saved();
  let all = (await batches()).slice(typedFrom);
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

  // A role set from Nendo's toolbar is saved as the block's Role, alone, and drawn on the sheet.
  assert((await page.evaluate(() => window.broker.toolbars.at(-1))).items.some(i => i.id === 'role' && i.options.some(o => o.value === 'Epigraph')), 'No Role control in the toolbar.');
  await select('b-0414', 3);
  const roleBefore = (await batches()).length;
  await page.evaluate(() => window.broker.command('role', 'Quotation'));
  await saved();
  const roleWrites = (await batches()).slice(roleBefore).flatMap(b => b.writes);
  assert(roleWrites.length === 1 && roleWrites[0].recordId === 'b-0414' && JSON.stringify(roleWrites[0].values) === JSON.stringify({ 'mn.block.role': 'Quotation' }), `Role write: ${JSON.stringify(roleWrites)}`);
  assert(await frame.evaluate(() => document.querySelector('[data-block="b-0414"]').dataset.role === 'Quotation'), 'The role is not drawn on the sheet.');
  await page.evaluate(() => window.broker.command('role', 'none'));
  await saved();
  assert((await record(BLOCK, 'b-0414')).values['mn.block.role'] === null, 'Clearing the role did not store null.');
  checks.push('roles from the toolbar');

  // The selected-paragraph bar: a note, then a link.
  await select('b-0414', 'ledger', 'shelf');
  await frame.getByRole('toolbar', { name: 'This paragraph' }).waitFor({ timeout: 3000 });
  await frame.getByRole('button', { name: 'Add a note', exact: true }).click();
  await frame.getByLabel('Note', { exact: true }).fill('Count the hands again.');
  // A redraw while the person types (somebody else's change arriving) keeps their words and focus.
  await page.evaluate(() => window.broker.pushChanges());
  await page.waitForTimeout(700);
  const typing = await frame.evaluate(() => ({ value: document.getElementById('note-text')?.value, focused: document.activeElement?.id }));
  assert(typing.value === 'Count the hands again.' && typing.focused === 'note-text', `A redraw took the note being typed: ${JSON.stringify(typing)}`);
  await frame.getByRole('button', { name: 'Add note' }).click();
  await frame.waitForFunction(() => window.manuscript.notes.length === 2, null, { timeout: 8000 })
    .catch(async () => { throw Error(`No note was created: ${JSON.stringify(await frame.evaluate(() => ({ selected: window.manuscript.selected, status: window.manuscript.status, problem: window.manuscript.problem, saveError: window.manuscript.saveError, popover: window.manuscript.popover })))}`); });
  const note = (await records('mn.note')).find(n => n.recordId !== 'n-1');
  assert(note.values['mn.note.block'] === 'b-0414' && note.values['mn.note.text'] === 'Count the hands again.', `Note: ${JSON.stringify(note)}`);
  await select('b-0413', 'tide', 'table');
  await frame.getByRole('button', { name: 'Link to a passage', exact: true }).click();
  await frame.getByLabel('Find a passage').fill('causeway');
  await frame.getByRole('listitem').filter({ hasText: 'The causeway was dry' }).click();
  await frame.waitForFunction(() => window.manuscript.links.length === 2);
  const link = (await records('mn.link')).find(l => l.recordId !== 'l-1');
  assert(link.values['mn.link.from'] === 'b-0413' && link.values['mn.link.to'] === 'b-0501', `Link: ${JSON.stringify(link)}`);
  checks.push('note and link from the bar');

  // W-279: the bar is icons in groups, with More last; no tool shows a word until it is pointed at.
  await select('b-0416', 'Agnes', 'three');
  await frame.getByRole('toolbar', { name: 'This paragraph' }).waitFor({ timeout: 3000 });
  const toolIds = () => frame.evaluate(() => [...document.querySelectorAll('.bar .tool')].map(t => t.dataset.tool ?? t.id));
  const drawn = await frame.evaluate(() => {
    const bar = document.querySelector('.bar'), tools = [...bar.querySelectorAll('.tool')];
    return { widest: Math.max(...tools.map(t => Math.round(t.getBoundingClientRect().width))),
      words: tools.map(t => [...t.childNodes].filter(n => !n.classList?.contains('tip')).map(n => n.textContent).join('').trim()).filter(Boolean),
      tipsShown: tools.filter(t => getComputedStyle(t.querySelector('.tip')).visibility !== 'hidden').length,
      dividers: bar.querySelectorAll('.divider').length, height: Math.round(bar.getBoundingClientRect().height) };
  });
  const firstBar = await toolIds();
  assert(JSON.stringify(firstBar) === JSON.stringify(['bold', 'italic', 'underline', 'align-left', 'align-centre', 'align-right', 'bulleted', 'numbered', 'link', 'note', 'cut', 'agent', 'more-tools'])
    && drawn.widest <= 32 && drawn.words.length === 0 && drawn.tipsShown === 0 && drawn.dividers === 4 && drawn.height <= 42, `Icon bar: ${JSON.stringify({ firstBar, drawn })}`);
  // Pointed at, a tool names itself and its keys, inside the frame; Copy for the agent names the block and its version.
  await frame.locator('.bar [data-tool="bold"]').hover();
  await page.waitForTimeout(700);
  const tip = await frame.evaluate(() => { const t = document.querySelector('.bar [data-tool="bold"] .tip'), r = t.getBoundingClientRect(), s = getComputedStyle(t);
    return { text: [...t.children].map(c => c.textContent).join(' | '), visibility: s.visibility, opacity: s.opacity, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.width > 40 }; });
  await page.screenshot({ path: '__OUTPUT__/bar-tooltip.png' });
  const ref = await frame.evaluate(() => [...document.querySelector('.bar [data-tool="agent"] .tip').children].map(c => c.textContent).join(' | '));
  const version0416 = (await record(BLOCK, 'b-0416')).version;
  assert(tip.text === 'Bold | Ctrl+B' && tip.visibility === 'visible' && tip.opacity === '1' && tip.inside && ref === `Copy for the agent | b-0416 · v${version0416}`, `Tooltip: ${JSON.stringify({ tip, ref })}`);
  checks.push('icon bar with tooltips');

  // Bold and underline go on the selected words, show as pressed, and are saved as Markdown, alone.
  let formatFrom = (await batches()).length;
  await frame.locator('.bar [data-tool="bold"]').click();
  await frame.locator('.bar [data-tool="underline"]').click();
  await saved();
  const pressedNow = ids => frame.evaluate(ids => ids.map(id => document.querySelector(`.bar [data-tool="${id}"]`)?.getAttribute('aria-pressed') ?? 'absent'), ids);
  const marked = { text: (await record(BLOCK, 'b-0416')).values[T], pressed: await pressedNow(['bold', 'underline', 'italic']),
    writes: (await batches()).slice(formatFrom).flatMap(b => b.writes).map(w => `${w.recordId}:${Object.keys(w.values ?? {}).join('+')}`) };
  assert(marked.text.startsWith('<u>**Agnes read it**</u> three times.') && marked.pressed.join() === 'true,true,false' && marked.writes.every(w => w === 'b-0416:mn.block.text'),
    `Bold and underline: ${JSON.stringify(marked)}`);
  checks.push('marks from the bar, saved as Markdown');

  // Centre sets the block's Align, alone, and draws it; Centre again gives it back to the layout.
  formatFrom = (await batches()).length;
  await frame.locator('.bar [data-tool="align-centre"]').click();
  await saved();
  const centred = { writes: (await batches()).slice(formatFrom).flatMap(b => b.writes).map(w => ({ id: w.recordId, values: w.values })), pressed: await pressedNow(['align-centre', 'align-left']),
    drawn: await frame.evaluate(() => getComputedStyle(document.querySelector('.sheet-text [data-block="b-0416"]')).textAlign) };
  assert(JSON.stringify(centred.writes) === JSON.stringify([{ id: 'b-0416', values: { 'mn.block.align': 'Centre' } }]) && centred.pressed.join() === 'true,false' && centred.drawn === 'center',
    `Centre: ${JSON.stringify(centred)}`);
  await frame.locator('.bar [data-tool="align-centre"]').click();
  await saved();
  assert((await record(BLOCK, 'b-0416')).values['mn.block.align'] === null && (await pressedNow(['align-left'])).join() === 'true', 'Centre chosen again did not give the block back to its layout.');
  // Right, kept, and the preview sets the paragraph so.
  await frame.locator('.bar [data-tool="align-right"]').click();
  await saved();
  await mode('book');
  await frame.waitForFunction(() => [...document.querySelectorAll('.sheet-body p')].some(e => e.textContent.includes('three times')), null, { timeout: 8000 });
  const previewAlign = await frame.evaluate(() => { const p = [...document.querySelectorAll('.sheet-body p')].find(e => e.textContent.includes('three times')); return p ? getComputedStyle(p).textAlign : null; });
  await mode('write');
  assert((await record(BLOCK, 'b-0416')).values['mn.block.align'] === 'Right' && previewAlign === 'right', `Right in the preview: ${previewAlign}`);
  checks.push('alignment saved and previewed');

  // More holds every tool not on the bar, by name and keys; a pin puts one on the bar, kept on this
  // device; right-click on it puts it back; Escape closes More.
  await select('b-0416', 'Agnes', 'three');
  await frame.locator('#more-tools').click();
  const menu = await frame.evaluate(() => { const m = document.getElementById('more-menu'); if (!m) return null; const r = m.getBoundingClientRect();
    return { tools: [...m.querySelectorAll('.more-tool')].map(b => b.dataset.tool), heads: [...m.querySelectorAll('.more-head')].map(h => h.textContent),
      strike: [...(m.querySelector('[data-tool="strike"]')?.querySelectorAll('.more-label, kbd') ?? [])].map(e => e.textContent).join(' | '),
      inside: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, box: [Math.round(r.top), Math.round(r.bottom), innerHeight],
      expanded: document.getElementById('more-tools').getAttribute('aria-expanded') }; });
  assert(menu && JSON.stringify(menu.tools) === JSON.stringify(['strike', 'code', 'highlight', 'clear', 'align-justify', 'paragraph', 'part', 'chapter', 'section', 'quotation', 'table'])
    && menu.heads.join() === 'Text,Alignment,Paragraph' && menu.strike === 'Strikethrough | Ctrl+Shift+S' && menu.inside && menu.expanded === 'true', `More: ${JSON.stringify(menu)}`);
  await page.screenshot({ path: '__OUTPUT__/bar-more.png' });
  await frame.locator('#more-menu [data-pin="highlight"]').click();
  const pinnedHighlight = { bar: await toolIds(), kept: await frame.evaluate(() => JSON.parse(localStorage.getItem('manuscript.bar') ?? 'null')?.pinned ?? null),
    inMore: await frame.evaluate(() => !!document.querySelector('#more-menu [data-tool="highlight"]')) };
  assert(pinnedHighlight.bar[3] === 'highlight' && pinnedHighlight.kept?.includes('highlight') && !pinnedHighlight.inMore, `Pin: ${JSON.stringify(pinnedHighlight)}`);
  await frame.locator('.bar [data-tool="highlight"]').click();
  await saved();
  assert((await record(BLOCK, 'b-0416')).values[T].startsWith('<u><mark>**Agnes read it**</mark></u> three'), `Highlight from a pinned tool: ${(await record(BLOCK, 'b-0416')).values[T]}`);
  await frame.locator('.bar [data-tool="highlight"]').click({ button: 'right' });
  await page.waitForTimeout(150);
  // Using a tool closed More; opened again, it holds the tool put back.
  await frame.locator('#more-tools').click();
  const unpinned = { bar: await toolIds(), kept: await frame.evaluate(() => JSON.parse(localStorage.getItem('manuscript.bar')).pinned),
    inMore: await frame.evaluate(() => !!document.querySelector('#more-menu [data-tool="highlight"]')), selection: await frame.evaluate(() => window.manuscriptSheet.editor.state.selection.empty) };
  assert(!unpinned.bar.includes('highlight') && !unpinned.kept.includes('highlight') && unpinned.inMore && unpinned.selection === false, `Unpin: ${JSON.stringify(unpinned)}`);
  // Strikethrough stays pinned, for the restart below to find.
  await frame.locator('#more-menu [data-pin="strike"]').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert(await frame.evaluate(() => !document.getElementById('more-menu') && document.activeElement?.closest('.ProseMirror') !== null), 'Escape did not close More and give the keyboard back to the writing.');
  checks.push('More, pin and unpin');

  // W-281: lists. "- " starts a bulleted item and Enter carries the list on; Tab takes an item a
  // level in; Enter on an empty item brings it out a level, then ends the list; "1. " starts a
  // numbered one. Each item is its own block, its List and Level saved.
  const underTide = async () => (await records(BLOCK)).filter(r => r.values[P] === 'b-ch-4').sort((a, b) => a.values[O] - b.values[O]);
  await select('b-0501', 'end');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- First post');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second post');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. Count');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Again');
  await saved();
  const listed = (await underTide()).map(r => [r.values[T], r.values['mn.block.list'] ?? null, r.values['mn.block.level'] ?? null]);
  assert(JSON.stringify(listed.slice(1, 5)) === JSON.stringify([['First post', 'Bulleted', null], ['Second post', 'Bulleted', 1], ['Count', 'Numbered', null], ['Again', 'Numbered', null]]),
    `Lists as blocks: ${JSON.stringify(listed)}`);
  const sheetList = await frame.evaluate(() => [...document.querySelectorAll('.sheet-text > p[data-list]')].map(p => ({ text: p.textContent, display: getComputedStyle(p).display, left: parseFloat(getComputedStyle(p).marginLeft) })));
  assert(sheetList.length === 4 && sheetList.every(i => i.display === 'list-item') && sheetList[1].left > sheetList[0].left && sheetList[2].left === sheetList[0].left,
    `Lists on the sheet: ${JSON.stringify(sheetList)}`);
  await mode('book');
  await frame.waitForFunction(() => document.querySelectorAll('.sheet-body .pv-li').length === 4, null, { timeout: 8000 })
    .catch(async () => { throw Error(`The preview has no list: ${await frame.evaluate(() => document.querySelectorAll('.sheet-body .pv-li').length)}`); });
  const markers = await frame.evaluate(() => [...document.querySelectorAll('.sheet-body .pv-li .pv-marker')].map(m => m.textContent));
  await mode('write');
  assert(JSON.stringify(markers) === JSON.stringify(['\u2022', '\u25E6', '1.', '2.']), `Preview markers: ${JSON.stringify(markers)}`);
  // The bar shows the list the item is in, and turns it into the other kind.
  await select((await underTide())[3].recordId, 'Count', 'end');
  await frame.getByRole('toolbar', { name: 'This paragraph' }).waitFor({ timeout: 3000 });
  assert((await pressedNow(['numbered', 'bulleted'])).join() === 'true,false', `List tools: ${await pressedNow(['numbered', 'bulleted'])}`);
  await frame.locator('.bar [data-tool="bulleted"]').click();
  await saved();
  assert((await underTide())[3].values['mn.block.list'] === 'Bulleted', 'Bulleted list from the bar was not saved.');
  // A list pasted from Word or a web page arrives as items, each its own block, levels kept.
  await select((await underTide())[4].recordId, 'end');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await frame.evaluate(() => window.manuscriptSheet.editor.view.pasteHTML('<ul><li>Alpha<ul><li><p>Beta</p></li></ul></li></ul><ol><li><p>One</p></li></ol>'));
  await saved();
  const pastedList = (await underTide()).map(r => [r.values[T], r.values['mn.block.list'] ?? null, r.values['mn.block.level'] ?? null]).filter(([text]) => ['Alpha', 'Beta', 'One'].includes(text));
  assert(JSON.stringify(pastedList) === JSON.stringify([['Alpha', 'Bulleted', null], ['Beta', 'Bulleted', 1], ['One', 'Numbered', null]]), `Pasted list: ${JSON.stringify((await underTide()).map(r => [r.values[T], r.values['mn.block.list'] ?? null, r.values['mn.block.level'] ?? null]))}`);
  checks.push('lists as blocks, typed, pasted and from the bar');

  // W-281: tables. Insert table puts a 3 by 3 table, its first row the header, after the block; it
  // is a Table block owning three Row blocks, each owning three Cell blocks, the text in the cells.
  await select((await underTide())[4].recordId, 'Again', 'end');
  await frame.locator('#more-tools').click();
  await frame.locator('#more-menu [data-tool="table"]').click();
  await frame.waitForFunction(() => document.querySelectorAll('.sheet-text table th').length === 3, null, { timeout: 3000 });
  for (const [i, word] of ['Post', 'Depth', 'Note', '4'].entries()) { if (i) await page.keyboard.press('Tab'); await page.keyboard.type(word); }
  await saved();
  const blocksNow = await records(BLOCK);
  const tableBlock = blocksNow.find(r => r.values[K] === 'Table');
  const rowsOf = id => blocksNow.filter(r => r.values[P] === id).sort((a, b) => a.values[O] - b.values[O]);
  const tableShape = tableBlock && { parent: tableBlock.values[P], after: (await underTide()).map(r => r.recordId).indexOf(tableBlock.recordId),
    rows: rowsOf(tableBlock.recordId).map(r => [r.values[K], ...rowsOf(r.recordId).map(c => `${c.values[K]}:${c.values[T] ?? ''}`)]) };
  assert(tableShape && tableShape.parent === 'b-ch-4' && tableShape.after === 5 && JSON.stringify(tableShape.rows) === JSON.stringify([
    ['Row', 'Cell:Post', 'Cell:Depth', 'Cell:Note'], ['Row', 'Cell:4', 'Cell:', 'Cell:'], ['Row', 'Cell:', 'Cell:', 'Cell:']]), `Table as blocks: ${JSON.stringify(tableShape ?? blocksNow.map(b => b.values[K]))}`);
  // In a table the bar offers the table's tools and the marks, not lists or alignment; Add row below adds a row of cells.
  await frame.evaluate(() => { const s = window.manuscriptSheet; let at = null;
    s.editor.state.doc.descendants((node, pos) => { if (!at && node.type.name === 'tableCell' && node.textContent === '4') at = pos; });
    s.editor.chain().focus().setTextSelection({ from: at + 2, to: at + 3 }).run(); });
  await frame.getByRole('toolbar', { name: 'This paragraph' }).waitFor({ timeout: 3000 });
  const inTable = await toolIds();
  assert(inTable.includes('row-after') && inTable.includes('column-after') && inTable.includes('bold') && !inTable.includes('align-left') && !inTable.includes('bulleted'), `Bar in a table: ${JSON.stringify(inTable)}`);
  await frame.locator('.bar [data-tool="row-after"]').click();
  await saved();
  assert(rowsOf(tableBlock.recordId).length === 3 && (await records(BLOCK)).filter(r => r.values[P] === tableBlock.recordId).length === 4, 'Add row below did not add a Row block.');
  await mode('book');
  await frame.waitForFunction(() => document.querySelector('.sheet-body table.pv-table th')?.textContent === 'Post', null, { timeout: 8000 })
    .catch(async () => { throw Error(`The preview has no table: ${await frame.evaluate(() => document.querySelector('.sheet-body table')?.outerHTML?.slice(0, 200) ?? 'none')}`); });
  await page.screenshot({ path: '__OUTPUT__/lists-and-table-preview.png' });
  await mode('write');
  await page.screenshot({ path: '__OUTPUT__/lists-and-table.png' });
  // Delete table takes the table, its rows and its cells out of the file.
  await frame.evaluate(() => { const s = window.manuscriptSheet; let at = null;
    s.editor.state.doc.descendants((node, pos) => { if (!at && node.type.name === 'tableHeader' && node.textContent === 'Post') at = pos; });
    s.editor.chain().focus().setTextSelection({ from: at + 2, to: at + 6 }).run(); });
  await frame.locator('#more-tools').click();
  await frame.locator('#more-menu [data-tool="table-delete"]').click();
  await saved();
  assert(!(await records(BLOCK)).some(r => ['Table', 'Row', 'Cell'].includes(r.values[K])), 'Delete table left Table, Row or Cell blocks in the file.');
  checks.push('tables as blocks, rows added, deleted whole');

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

  // The side panel (owner, 2026-10-17: it showed blank on open, and Close did nothing): no box
  // until it is opened; opened from Nendo's toolbar it shows its title and presses the toggle;
  // the close button and Escape put it away, and the toggle is released.
  const panel = () => frame.evaluate(() => { const d = document.getElementById('drawer'), r = d.getBoundingClientRect();
    return { shown: r.width > 0 && getComputedStyle(d).display !== 'none', title: d.querySelector('.drawer-title')?.textContent ?? null }; });
  const pressed = id => page.evaluate(id => window.broker.toolbars.at(-1).items.find(i => i.id === id)?.pressed ?? null, id);
  const panels = { start: await panel() };
  await page.evaluate(() => window.broker.command('notes'));
  await page.waitForTimeout(200);
  panels.open = { ...(await panel()), pressed: await pressed('notes') };
  await frame.click('.drawer-close');
  await page.waitForTimeout(250);
  panels.closed = { ...(await panel()), pressed: await pressed('notes') };
  await page.evaluate(() => window.broker.command('related'));
  await page.waitForTimeout(200);
  await frame.focus('.drawer-close');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  panels.escaped = { ...(await panel()), pressed: await pressed('related'), focusInEditor: await frame.evaluate(() => document.activeElement?.closest('.ProseMirror') !== null) };
  assert(!panels.start.shown && panels.open.shown && panels.open.title === 'Notes' && panels.open.pressed === true && !panels.closed.shown && panels.closed.pressed === false
    && !panels.escaped.shown && panels.escaped.pressed === false && panels.escaped.focusInEditor, `Side panel: ${JSON.stringify(panels)}`);
  checks.push('side panel opens and closes');

  // Light and Dark, and a narrow frame.
  const colours = {};
  for (const mode of ['light', 'dark']) {
    await page.evaluate(m => window.broker.pushTheme(m), mode);
    await page.waitForTimeout(150);
    colours[mode] = await frame.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.querySelector('.sheet-text')).color }));
    await select('b-0415', 'pencil', 'line');
    await page.waitForTimeout(100);
    // The view was stopped and started since Strikethrough was pinned: the bar still has it.
    assert((await toolIds()).includes('strike'), `A pin did not outlast the view: ${JSON.stringify(await toolIds())}`);
    colours[mode].tip = await frame.evaluate(() => { const t = document.querySelector('.bar .tip'), s = getComputedStyle(t); return { background: s.backgroundColor, ink: s.color }; });
    await page.screenshot({ path: '__OUTPUT__/' + mode + '.png' });
  }
  assert(colours.light.background !== colours.dark.background && colours.light.ink !== colours.dark.ink && colours.light.tip.background !== colours.dark.tip.background
    && colours.light.tip.background !== colours.light.tip.ink, `Theme: ${JSON.stringify(colours)}`);
  await page.setViewportSize({ width: 620, height: 900 }); await page.waitForTimeout(150);
  const narrow = await frame.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, bar: document.querySelector('.bar')?.getBoundingClientRect().right, width: innerWidth }));
  assert(narrow.overflow <= 1 && (narrow.bar === undefined || narrow.bar <= narrow.width + 1), `Narrow: ${JSON.stringify(narrow)}`);
  checks.push('Light/Dark', 'narrow layout');

  // A picture's height is known before a sheet is filled: laid out before it loaded, a figure took
  // no room, then grew and pushed the lines under it past the sheet's edge, where they were cut off
  // (owner, 2026-10-16). With a real picture offered, nothing in a column ends below its sheet's text.
  await page.setViewportSize({ width: 1440, height: 900 });
  const tallPicture = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 600; const g = c.getContext('2d'); g.fillStyle = '#4a7'; g.fillRect(0, 0, 400, 600); return c.toDataURL('image/png'); });
  await page.evaluate(urls => window.broker.offerMedia(urls), { [`media:${'ab'.repeat(32)}`]: tallPicture });
  // Text after the picture, enough to fill a column, so a figure that grows late has lines to push.
  await page.evaluate(() => {
    const words = 'The water went out further than anyone in the village could remember, and the posts of the old causeway stood up out of the sand one after another, each with its number cut into the top.';
    for (let i = 1; i <= 8; i++) window.broker.put('mn.block', { entityId: 'mn.block', recordId: `b-after-${i}`, version: 1, labels: {},
      values: { 'mn.block.kind': 'Paragraph', 'mn.block.parent': 'b-ch-4', 'mn.block.order': 1000000 + i, 'mn.block.text': `${words} ${words}` } });
    // Sections whose text takes about half a column, so the next heading fits under one and its
    // text does not: the place a heading is left behind unless it moves on with its text.
    for (let i = 1; i <= 14; i++) {
      window.broker.put('mn.block', { entityId: 'mn.block', recordId: `b-sec-${i}`, version: 1, labels: {},
        values: { 'mn.block.kind': 'Section', 'mn.block.parent': 'b-ch-4', 'mn.block.order': 2000000 + i, 'mn.block.text': `Posts ${i}` } });
      window.broker.put('mn.block', { entityId: 'mn.block', recordId: `b-sec-${i}-p`, version: 1, labels: {},
        values: { 'mn.block.kind': 'Paragraph', 'mn.block.parent': `b-sec-${i}`, 'mn.block.order': 1024, 'mn.block.text': `${Array(5).fill(words).join(' ')} ${words.split(' ').slice(0, i * 3).join(' ')}` } });
    }
  });
  const framePrevious = frame;
  await page.evaluate(() => window.broker.remount());
  frame = null;
  for (let i = 0; i < 200 && frame === null; i++) { frame = page.frames().find(f => f.url().startsWith(origin + '/') && f !== framePrevious) ?? null; if (frame === null) await page.waitForTimeout(50); }
  assert(frame !== null, 'The view did not start again with pictures offered.');
  await frame.waitForFunction(() => window.manuscript?.status?.startsWith('Saved') || window.manuscript?.status?.startsWith('Up to date'), null, { timeout: 10000 }).catch(() => {});
  await mode('paper');
  await frame.waitForFunction(() => [...document.querySelectorAll('.pv-picture img')].some(img => img.complete && img.naturalHeight > 0), null, { timeout: 8000 })
    .catch(async () => { throw Error(`The offered picture did not reach the preview: ${JSON.stringify(await frame.evaluate(() => document.querySelector('.pv-figure')?.outerHTML.slice(0, 300) ?? null))}`); });
  await page.waitForTimeout(300);
  const clipped = await frame.evaluate(() => [...document.querySelectorAll('.sheet-page')].flatMap((sheet, n) => {
    const body = sheet.querySelector('.sheet-body').getBoundingClientRect();
    return [...sheet.querySelectorAll('.pv-column > *, .sheet-body > :not(.pv-columns)')]
      .filter(e => e.getBoundingClientRect().bottom > body.bottom + 1)
      .map(e => ({ page: n + 1, block: e.className || e.tagName, text: e.textContent.slice(0, 40), over: Math.round(e.getBoundingClientRect().bottom - body.bottom) }));
  }));
  const figure = await frame.evaluate(() => { const box = document.querySelector('.pv-picture').getBoundingClientRect(); return { width: Math.round(box.width), height: Math.round(box.height) }; });
  assert(clipped.length === 0 && figure.height > figure.width, `The preview cuts off what runs past a sheet: ${JSON.stringify({ clipped, figure })}`);
  // A heading stays with the text after it: no column or sheet ends on one (owner, 2026-10-17).
  const stranded = await frame.evaluate(() => [...document.querySelectorAll('.sheet-page')].flatMap((sheet, n) =>
    [...sheet.querySelectorAll('.pv-column, .sheet-body')].map(box => box.matches('.sheet-body') ? [...box.children].filter(e => !e.matches('.pv-columns')).at(-1) : box.lastElementChild)
      .filter(last => last && /^H[2-4]$/.test(last.tagName) && last.nextElementSibling === null).map(last => ({ page: n + 1, heading: last.textContent }))));
  // And the columns start below what runs across the first page, with room between.
  const gap = await frame.evaluate(() => { const columns = document.querySelector('.sheet-page .sheet-body > .pv-columns'), before = columns?.previousElementSibling;
    const zoom = columns ? columns.getBoundingClientRect().width / columns.offsetWidth : 1;
    return before ? Math.round((columns.getBoundingClientRect().top - before.getBoundingClientRect().bottom) / zoom) : null; });
  const headings = await frame.evaluate(() => [...document.querySelectorAll('.pv-column :is(h2, h3, h4)')].filter(h => /Posts \d+$/.test(h.textContent)).length);
  assert(stranded.length === 0 && headings >= 14 && gap !== null && gap >= 18, `Paper preview: headings left without their text, or no room above the columns: ${JSON.stringify({ stranded, headings, gap })}`);
  await page.screenshot({ path: '__OUTPUT__/preview-paper-picture.png' });
  await mode('write');
  checks.push('preview makes room for pictures', 'headings kept with their text', 'room above the columns');
  assert(!(await batches()).some(b => b.writes.some(w => w.recordId === 'b-0502')), 'An edit elsewhere rewrote the picture block.');

  // A file built before alignment has no Align field: the bar and More offer no alignment, and
  // its keys write nothing.
  const older = JSON.parse(JSON.stringify(manusFixture));
  for (const e of older.schema.entities) {
    e.fields = e.fields.filter(f => !['mn.block.align', 'mn.block.list', 'mn.block.level'].includes(f.fieldId));
    for (const f of e.fields) if (f.fieldId === 'mn.block.kind') f.choices = f.choices.filter(c => !['Table', 'Row', 'Cell'].includes(c.id));
  }
  const frameBeforeOlder = frame;
  await page.evaluate(f => { window.broker.setFixture(f); window.broker.remount(); }, older);
  frame = null;
  for (let i = 0; i < 200 && frame === null; i++) { frame = page.frames().find(f => f.url().startsWith(origin + '/') && f !== frameBeforeOlder) ?? null; if (frame === null) await page.waitForTimeout(50); }
  assert(frame !== null, 'The view did not start on a file without the Align field.');
  await frame.waitForFunction(() => window.manuscript?.root === 'b-root' && document.querySelector('.sheet-text [data-block="b-0416"]'), null, { timeout: 15000 });
  await select('b-0416', 'Agnes', 'three');
  await frame.getByRole('toolbar', { name: 'This paragraph' }).waitFor({ timeout: 3000 });
  await frame.locator('#more-tools').click();
  const olderBefore = (await batches()).length;
  await page.keyboard.press('Control+Shift+E');
  await page.waitForTimeout(1800);
  const withoutAlign = { bar: await toolIds(), more: await frame.evaluate(() => [...document.querySelectorAll('#more-menu .more-tool')].map(b => b.dataset.tool)),
    writes: (await batches()).slice(olderBefore).flatMap(b => b.writes), drawn: await frame.evaluate(() => document.querySelector('.sheet-text [data-block="b-0416"]').dataset.align ?? null) };
  assert(!withoutAlign.bar.some(id => id.startsWith('align-')) && !withoutAlign.more.some(id => id.startsWith('align-')) && withoutAlign.more.includes('code')
    && withoutAlign.writes.length === 0 && withoutAlign.drawn === null, `A file without the Align field: ${JSON.stringify(withoutAlign)}`);
  // Nor lists or tables without their fields and kinds: no tools, and "- " typed stays text.
  assert(!withoutAlign.bar.includes('bulleted') && !withoutAlign.bar.includes('numbered') && !withoutAlign.more.includes('table'), `A file without lists or tables: ${JSON.stringify(withoutAlign)}`);
  await page.keyboard.press('Escape');
  await select('b-0416', 'end');
  const plainFrom = (await batches()).length;
  await page.keyboard.press('Enter');
  await page.keyboard.type('- not a list');
  await saved();
  const plainDash = (await batches()).slice(plainFrom).flatMap(b => b.writes);
  assert(plainDash.length === 1 && plainDash[0].op === 'create' && plainDash[0].values[T] === '\\- not a list' && !('mn.block.list' in plainDash[0].values), `"- " without the List field: ${JSON.stringify(plainDash)}`);
  checks.push('no alignment, lists or tables without their fields');
  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, colours, narrow, errors };
  })(); } catch (error) { throw Error(`After [${checks.join(', ')}]: ${error.message}`); }
}
