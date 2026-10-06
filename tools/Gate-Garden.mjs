async page => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Leaving a dirty note asks the person; the probe always says yes.
  page.on('dialog', dialog => dialog.accept());
  const checks = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__BROKER_URL__');
  const fixture = '__GARDEN_FIXTURE__';
  await page.evaluate(fixture => { window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.offerPlaces(true); window.broker.setFixture(fixture); }, fixture);
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  const mounted = async () => {
    for (let i = 0; i < 200; i++) { const f = page.frames().find(f => f.url().startsWith(origin + '/')); if (f) return f; await page.waitForTimeout(50); }
    throw Error('Garden frame did not mount.');
  };
  let frame = await mounted();
  await frame.waitForFunction(() => window.garden?.ready === true, { timeout: 15000 });
  const command = (id, value = null) => page.evaluate(({ id, value }) => window.broker.command(id, value), { id, value });
  const records = entity => page.evaluate(entity => window.broker.records(entity), entity);
  const requests = method => page.evaluate(method => window.broker.requests.filter(r => r.m === method).length, method);
  const state = () => frame.evaluate(() => ({ note: window.garden.note?.recordId ?? null, version: window.garden.note?.version ?? null, dirty: window.garden.dirty, external: window.garden.external, problem: window.garden.problem, index: window.garden.index.length, undo: window.garden.undo.length }));
  const seedNotes = fixture.records['gd.note'].length;
  const F = { body: 'gd.note.body', slug: 'gd.note.slug', stage: 'gd.note.stage', touched: 'gd.note.touched', from: 'gd.link.from', to: 'gd.link.to', kind: 'gd.link.kind', context: 'gd.link.context', source: 'gd.link.source', tagName: 'gd.tag.name', noteTagTag: 'gd.noteTag.tag', noteTagNote: 'gd.noteTag.note', taskTitle: 'gd.task.title', taskDone: 'gd.task.done', taskSource: 'gd.task.source', taskNote: 'gd.task.note' };

  // 1. Mounted: the tree lists every seed, the toolbar was accepted by Nendo's rules, Add is the view's.
  assert(await frame.locator('#tree .row').count() === seedNotes, `The tree must list the ${seedNotes} seed notes.`);
  const refusals = await page.evaluate(() => window.broker.chromeRefusals);
  assert(refusals.length === 0, 'Nendo refused a Garden toolbar declaration: ' + JSON.stringify(refusals));
  const toolbars = await page.evaluate(() => window.broker.toolbars);
  assert(toolbars.length > 0 && toolbars.at(-1).add === 'new', 'The toolbar must hand Add to the view\'s new-note command.');
  assert(await frame.evaluate(() => getComputedStyle(document.getElementById('own-toolbar')).display === 'none'), 'With Nendo\'s toolbar offered the view draws no controls of its own.');
  checks.push('mount');

  // 2. Open Start here from the tree: the preview links, a click follows one and declares a place.
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here');
  const seedLinks = fixture.records['gd.link'].filter(l => l.values[F.from] === 'gd.note.start-here' && l.values[F.source] === 'Body').length;
  assert(await frame.locator('#preview a.wikilink[data-id]').count() === seedLinks, `The preview must resolve the ${seedLinks} wikilinks of Start here.`);
  assert(await frame.locator('#backlinks li button').count() === fixture.records['gd.link'].filter(l => l.values[F.to] === 'gd.note.start-here').length, 'Backlinks under the note must match the link rows into it.');
  await frame.locator('#preview a.wikilink[data-id="gd.note.how-links-work"]').first().click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.how-links-work');
  const places = await page.evaluate(() => window.broker.places);
  assert(places.some(p => p.place.noteId === 'gd.note.how-links-work' && p.label === 'How links work' && !p.replace), 'Following a wikilink must declare a new place named after the note: ' + JSON.stringify(places));
  checks.push('wikilink navigation and places');

  // 3. [[ autocomplete.
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here' && !window.garden.dirty);
  const original = await frame.evaluate(() => document.getElementById('editor').value);
  await frame.locator('#editor').focus();
  await frame.evaluate(() => { const e = document.getElementById('editor'); e.setSelectionRange(e.value.length, e.value.length); });
  await page.keyboard.type('\nAlso [[da');
  await frame.waitForFunction(() => !document.getElementById('autocomplete').hidden);
  assert(await frame.locator('#autocomplete li[aria-selected=true]').textContent() === 'Daily notesdaily-notes', 'Autocomplete must offer Daily notes first for [[da: ' + await frame.locator('#autocomplete').innerText());
  await page.keyboard.press('Enter');
  assert((await frame.evaluate(() => document.getElementById('editor').value)).endsWith('Also [[daily-notes]]'), 'Enter must insert the picked slug.');
  assert(await frame.locator('#autocomplete').isHidden(), 'The listbox closes after a pick.');
  checks.push('autocomplete');

  // 4. Save: one batch plants a stub, a link with context, a tag with its note tag, and a task.
  await page.keyboard.type(' and [[A brand new note]] #planted\n- [ ] Water the seeds');
  const batchesBefore = await requests('records.batch');
  await command('save');
  await frame.waitForFunction(() => !window.garden.dirty && window.garden.undo.length === 1);
  assert(await requests('records.batch') === batchesBefore + 1, 'Save must be exactly one records.batch.');
  const notes = await records('gd.note');
  const stub = notes.find(n => n.values[F.slug] === 'a-brand-new-note');
  assert(stub && stub.values[F.stage] === 'Seed', 'The unknown wikilink must plant a Seed note with its slug.');
  assert(notes.length === seedNotes + 1 && await frame.locator('#tree .row').count() === seedNotes + 1, 'The tree must show the planted seed.');
  const saved = notes.find(n => n.recordId === 'gd.note.start-here');
  assert(saved.values[F.body].includes('[[daily-notes]]') && saved.values[F.touched] === new Date().toISOString().slice(0, 10), 'The body and the touched date must be stored.');
  const links = await records('gd.link');
  const toStub = links.find(l => l.values[F.from] === 'gd.note.start-here' && l.values[F.to] === stub.recordId);
  assert(toStub && toStub.values[F.kind] === 'Mentions' && toStub.values[F.source] === 'Body' && toStub.values[F.context].includes('[[A brand new note]]'), 'The link to the seed must carry its sentence: ' + JSON.stringify(toStub));
  assert(links.some(l => l.values[F.from] === 'gd.note.start-here' && l.values[F.to] === 'gd.note.daily-notes'), 'The autocompleted link must be a Link row.');
  const tags = await records('gd.tag');
  const planted = tags.find(t => t.values[F.tagName] === 'planted');
  assert(planted && (await records('gd.noteTag')).some(nt => nt.values[F.noteTagTag] === planted.recordId && nt.values[F.noteTagNote] === 'gd.note.start-here'), 'The new #tag must be a Tag with a Note tag.');
  assert(tags.filter(t => t.values[F.tagName] === 'garden').length === 1, 'An existing tag is reused, never made again.');
  const task = (await records('gd.task')).find(t => t.values[F.taskTitle] === 'Water the seeds');
  assert(task && task.values[F.taskDone] === false && task.values[F.taskSource] === 'Checkbox' && task.values[F.taskNote] === 'gd.note.start-here', 'The checkbox must be a Task row.');
  assert(await frame.locator('#preview a.wikilink.missing').count() === 0, 'After the save every wikilink resolves.');
  checks.push('one-batch save derives records');

  // 5. Remove the link: its row goes, the seed and the seeded Manual link stay.
  const manualBefore = (await records('gd.link')).filter(l => l.values[F.source] === 'Manual').length;
  await frame.evaluate(() => { const e = document.getElementById('editor'); e.value = e.value.replace(' and [[A brand new note]]', ''); e.dispatchEvent(new Event('input', { bubbles: true })); });
  await command('save');
  await frame.waitForFunction(() => !window.garden.dirty && window.garden.undo.length === 2);
  const after = await records('gd.link');
  assert(!after.some(l => l.values[F.to] === stub.recordId), 'The removed wikilink\'s row must be deleted.');
  assert((await records('gd.note')).some(n => n.recordId === stub.recordId), 'The planted seed stays when its link goes.');
  assert(after.filter(l => l.values[F.source] === 'Manual').length === manualBefore && manualBefore > 0, 'A Manual link is never touched by a save.');
  checks.push('link removal keeps Manual rows');

  // 6. Tick the checkbox: the same task row is updated, by its key.
  await frame.evaluate(() => { const e = document.getElementById('editor'); e.value = e.value.replace('- [ ] Water the seeds', '- [x] Water the seeds'); e.dispatchEvent(new Event('input', { bubbles: true })); });
  await command('save');
  await frame.waitForFunction(() => !window.garden.dirty && window.garden.undo.length === 3);
  const ticked = (await records('gd.task')).find(t => t.recordId === task.recordId);
  assert(ticked && ticked.values[F.taskDone] === true, 'Ticking must update the same task record (matched by key), not make another.');
  assert((await records('gd.task')).filter(t => t.values[F.taskTitle] === 'Water the seeds').length === 1, 'One task row per checkbox.');
  checks.push('checkbox done by key');

  // 7. Undo takes the last save back as one step.
  const undosBefore = await requests('records.undo');
  await command('undo');
  await frame.waitForFunction(() => window.garden.undo.length === 2);
  assert(await requests('records.undo') === undosBefore + 1, 'Undo must be exactly one records.undo.');
  assert((await records('gd.task')).find(t => t.recordId === task.recordId).values[F.taskDone] === false, 'Undo must put the task back to open.');
  assert((await frame.evaluate(() => document.getElementById('editor').value)).includes('- [ ] Water the seeds'), 'Undo must reload the body.');
  checks.push('undo');

  // 8. A refused batch keeps the draft; a change elsewhere blocks a save of a dirty draft.
  await frame.evaluate(() => { const e = document.getElementById('editor'); e.value += '\nMore.'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => window.broker.fail('records.batch', { code: 'record-version-conflict', message: 'The record changed. Review its current values.' }, 1));
  await command('save');
  await frame.waitForFunction(() => document.getElementById('problem').textContent.includes('kept'));
  assert((await state()).dirty === true, 'A refused save must keep the draft.');
  await page.evaluate(() => { window.broker.touch('gd.note', 'gd.note.start-here'); window.broker.pushChanges(); });
  await frame.waitForFunction(() => document.getElementById('status').textContent.includes('changed elsewhere'));
  const blockedBefore = await requests('records.batch');
  await command('save');
  await page.waitForTimeout(200);
  assert(await requests('records.batch') === blockedBefore, 'A draft over a note changed elsewhere must not be written over it.');
  assert((await state()).dirty === true, 'The draft is kept after the block.');
  checks.push('refused save and external change');

  // 9. A body past the MCP value bound is refused in the frame, with no batch.
  await frame.locator('#tree .row[data-id="gd.note.daily-notes"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.daily-notes', { timeout: 5000 });
  await frame.evaluate(() => { const e = document.getElementById('editor'); e.value = 'x'.repeat(33000); e.dispatchEvent(new Event('input', { bubbles: true })); });
  const bigBefore = await requests('records.batch');
  await command('save');
  await frame.waitForFunction(() => document.getElementById('problem').textContent.includes('32,768'));
  assert(await requests('records.batch') === bigBefore, 'A body over 32 KiB must send no batch.');
  checks.push('32 KiB body refused');

  // 10. Light and Dark: the frame's colours follow the theme, the wikilink is the cobalt token.
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here');
  const colours = {};
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => window.broker.pushTheme(mode), mode); await page.waitForTimeout(100);
    colours[mode] = await frame.evaluate(() => {
      const token = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      return { background: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color,
        wikilink: getComputedStyle(document.querySelector('#preview a.wikilink')).color, cobalt: token('cobalt') };
    });
    assert(colours[mode].wikilink === colours[mode].cobalt, `${mode}: a wikilink must be the cobalt token: ${JSON.stringify(colours[mode])}`);
    await page.screenshot({ path: '__OUTPUT__/' + mode + '.png', fullPage: true });
  }
  assert(colours.light.background !== colours.dark.background && colours.light.ink !== colours.dark.ink, 'The theme must change the frame.');
  checks.push('Light/Dark');

  // 11. The Backlinks panel on a note's page.
  await page.evaluate(fixture => { window.broker.setFixture({ ...fixture, context: { ...fixture.context, viewId: 'gd.note.page.backlinks', kind: 'extensionRecordPanel', placement: 'recordPage', recordId: 'gd.note.how-links-work', title: 'Backlinks' } }); window.broker.remount(); }, fixture);
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.garden?.mode === 'panel');
  const into = fixture.records['gd.link'].filter(l => l.values[F.to] === 'gd.note.how-links-work');
  assert(await frame.locator('#panel-backlinks li button').count() === into.length, `The panel must list the ${into.length} links into How links work.`);
  const firstRow = await frame.locator('#panel-backlinks li').first().innerText();
  assert(firstRow.includes(into[0].labels[F.from]) && firstRow.includes(into[0].values[F.context].slice(0, 20)), 'A backlink row names its source note and its sentence: ' + firstRow);
  assert(await frame.locator('#panel-tasks li').count() === fixture.records['gd.task'].filter(t => t.values[F.taskNote] === 'gd.note.how-links-work').length || await frame.locator('#panel-tasks li.none').count() === 1, 'The panel lists the note\'s tasks or says there are none.');
  const openedBefore = (await page.evaluate(() => window.broker.opened())).length;
  await frame.locator('#panel-backlinks li button').first().click();
  await page.waitForTimeout(100);
  const opened = await page.evaluate(() => window.broker.opened());
  assert(opened.length === openedBefore + 1 && opened.at(-1).entityId === 'gd.note' && opened.at(-1).recordId === into[0].values[F.from], 'A backlink row opens its source note, exactly once.');
  checks.push('backlinks panel');

  // 12. Narrow: the sidebar stacks above the editor and nothing scrolls sideways.
  await page.evaluate(fixture => { window.broker.setFixture(fixture); window.broker.remount(); }, fixture);
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.garden?.ready === true);
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here');
  await page.setViewportSize({ width: 620, height: 1000 }); await page.waitForTimeout(150);
  const narrow = await frame.evaluate(() => { const s = document.getElementById('sidebar').getBoundingClientRect(), m = document.getElementById('main').getBoundingClientRect(); return { sidebarBottom: s.bottom, mainTop: m.top, overflow: document.documentElement.scrollWidth - innerWidth, width: innerWidth }; });
  assert(narrow.mainTop >= narrow.sidebarBottom - 1 && narrow.overflow <= 1, `Narrow panes must stack without overflow: ${JSON.stringify(narrow)}`);
  await page.screenshot({ path: '__OUTPUT__/narrow.png', fullPage: true });
  checks.push('narrow layout');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, colours, narrow, checks, errors };
}
