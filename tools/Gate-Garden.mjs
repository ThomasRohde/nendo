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

  // 2. The garden opens on its pinned map, for reading: the page, not the Markdown.
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here');
  const visible = selector => frame.evaluate(selector => { const e = document.querySelector(selector); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; }, selector);
  assert(await frame.evaluate(() => window.garden.mode) === 'read' && await visible('#reading') && !await visible('#editor'), 'A note must open for reading, with the editor out of sight.');
  assert(await frame.locator('#reading-title').textContent() === 'Start here', 'Reading shows the title as the page heading.');
  const seedLinks = fixture.records['gd.link'].filter(l => l.values[F.from] === 'gd.note.start-here' && l.values[F.source] === 'Body').length;
  assert(await frame.locator('#reading-body a.wikilink[data-id]').count() === seedLinks, `Reading must resolve the ${seedLinks} wikilinks of Start here.`);
  assert(await frame.locator('#backlinks li button').count() === fixture.records['gd.link'].filter(l => l.values[F.to] === 'gd.note.start-here').length, 'Backlinks under the note must match the link rows into it.');
  // Width, three levels: Full fills the view, Narrow and Medium keep a centred column.
  const sheet = () => frame.evaluate(() => { const r = document.getElementById('reading').getBoundingClientRect(), m = document.getElementById('note').getBoundingClientRect();
    return { width: r.width, left: r.left - m.left, right: m.right - r.right, note: m.width }; });
  const fullSheet = await sheet();
  assert(fullSheet.note - fullSheet.width <= 60, `Full must fill the view: ${JSON.stringify(fullSheet)}.`);
  await command('width', 'narrow');
  const narrowSheet = await sheet();
  assert(narrowSheet.width <= 760 && Math.abs(narrowSheet.left - narrowSheet.right) <= 2, `Narrow must keep a centred column of at most 760 px: ${JSON.stringify(narrowSheet)}.`);
  await command('width', 'medium');
  const mediumSheet = await sheet();
  assert(mediumSheet.width > narrowSheet.width && mediumSheet.width <= 1120, `Medium must sit between Narrow and Full: ${JSON.stringify(mediumSheet)}.`);
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.some(i => i.id === 'width' && i.value === 'medium' && i.options.length === 3), null, { timeout: 2000 })
    .catch(() => { throw Error('Nendo\'s row must show the width chosen, of three.'); });
  await command('width', 'full');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '__OUTPUT__/reading.png', fullPage: true });
  checks.push('opens for reading');

  // The local graph: the note and every note one link away, either way.
  const near = new Set(['gd.note.start-here']);
  for (const l of fixture.records['gd.link']) { if (l.values[F.from] === 'gd.note.start-here') near.add(l.values[F.to]); if (l.values[F.to] === 'gd.note.start-here') near.add(l.values[F.from]); }
  await frame.waitForFunction(count => document.querySelectorAll('#local-graph .node').length === count, near.size, { timeout: 5000 }).catch(async () => { throw Error(`The local graph must draw ${near.size} notes, drew ${await frame.locator('#local-graph .node').count()}.`); });
  assert(await frame.locator('#local-graph .node.current[data-id="gd.note.start-here"]').count() === 1, 'The local graph marks the note it is about.');
  checks.push('local graph');

  // Hovering a wikilink previews the note it names.
  const hoverLink = frame.locator('#reading-body a.wikilink[data-id="gd.note.how-links-work"]').first();
  const linkBox = await hoverLink.boundingBox();
  await page.mouse.move(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
  await frame.waitForFunction(() => !document.getElementById('hover-card').hidden, { timeout: 3000 }).catch(() => { throw Error('Hovering a wikilink must preview its note.'); });
  assert(await frame.locator('#hover-title').textContent() === 'How links work', 'The preview names the linked note.');
  await page.mouse.move(5, 5);
  checks.push('hover preview');

  // Ticking a task while reading saves it at once, in one batch, and the page stays a page.
  const tickBefore = await requests('records.batch');
  await frame.locator('#reading-body input[type=checkbox][data-line]').first().click();
  await frame.waitForFunction(() => window.garden.undo.length === 1 && !window.garden.dirty);
  assert(await requests('records.batch') === tickBefore + 1, 'A tick while reading must be exactly one records.batch.');
  const ticked0 = (await records('gd.task')).find(t => t.values[F.taskTitle] === 'Plant your first note with **New note**');
  assert(ticked0?.values[F.taskDone] === true, 'The ticked task record must be done.');
  assert((await records('gd.note')).find(n => n.recordId === 'gd.note.start-here').values[F.body].includes('- [x] Plant your first note'), 'The tick must be written into the body.');
  assert(await frame.evaluate(() => window.garden.mode) === 'read', 'Ticking keeps the page in reading.');
  checks.push('tick while reading');

  // A wikilink followed while reading opens its note and declares a place.
  await frame.locator('#reading-body a.wikilink[data-id="gd.note.how-links-work"]').first().click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.how-links-work');
  const places = await page.evaluate(() => window.broker.places);
  assert(places.some(p => p.place.noteId === 'gd.note.how-links-work' && p.label === 'How links work' && !p.replace), 'Following a wikilink must declare a new place named after the note: ' + JSON.stringify(places));
  checks.push('wikilink navigation and places');

  // 3. [[ autocomplete.
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here' && !window.garden.dirty);
  await command('mode', 'edit');
  await frame.waitForFunction(() => window.garden.mode === 'edit');
  assert(await visible('#editor') && !await visible('#reading'), 'Edit must swap the page for its Markdown.');
  // The API sends a declaration at most every tenth of a second, so wait for the one that follows Edit.
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.some(i => i.id === 'mode' && i.value === 'edit' && i.options.map(o => o.label).join() === 'View,Edit'), null, { timeout: 2000 })
    .catch(async () => { throw Error('Nendo\'s row must show the two modes, View and Edit, with Edit chosen: ' + JSON.stringify((await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(i => i.id === 'mode'))); });
  // Editing takes the whole view: the panes reach the bottom and both sides, the cards wait for reading.
  await page.waitForTimeout(100);
  const space = await frame.evaluate(() => {
    const box = id => document.getElementById(id).getBoundingClientRect();
    const main = box('main'), panes = box('panes'), editor = box('editor'), preview = box('preview');
    return { mainBottom: main.bottom, mainWidth: main.width, panesWidth: panes.width, editorBottom: editor.bottom, previewBottom: preview.bottom, editorHeight: editor.height,
      about: getComputedStyle(document.getElementById('about')).display };
  });
  assert(space.mainBottom - space.editorBottom <= 16 && space.mainBottom - space.previewBottom <= 16 && space.mainWidth - space.panesWidth <= 30 && space.about === 'none',
    `The editor and the preview must fill the view while editing: ${JSON.stringify(space)}.`);
  // And in a wide window too, where a box sized by its content would leave margins.
  await page.setViewportSize({ width: 2560, height: 1200 }); await page.waitForTimeout(150);
  const wide = await frame.evaluate(() => { const m = document.getElementById('main').getBoundingClientRect(), p = document.getElementById('panes').getBoundingClientRect();
    return { mainWidth: m.width, panesWidth: p.width, leftGap: p.left - m.left, rightGap: m.right - p.right }; });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(150);
  assert(wide.mainWidth - wide.panesWidth <= 1 && wide.leftGap <= 1 && wide.rightGap <= 1, `In a wide window editing must still fill the view, with no margins: ${JSON.stringify(wide)}.`);
  const tight = await frame.evaluate(() => {
    const box = id => document.getElementById(id).getBoundingClientRect(), colour = id => getComputedStyle(document.getElementById(id)).backgroundColor;
    const surface = (() => { const e = document.createElement('i'); e.style.color = 'var(--nendo-surface, #ffffff)'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })();
    return { titleGap: box('title').top - box('main').top, panesLeft: box('panes').left - box('main').left, body: getComputedStyle(document.body).backgroundColor,
      main: colour('main'), sidebar: colour('sidebar'), surface, titleBorder: getComputedStyle(document.getElementById('title')).borderTopWidth, editorBorder: getComputedStyle(document.getElementById('editor')).borderLeftWidth };
  });
  assert(tight.titleGap <= 1 && tight.panesLeft <= 1 && tight.body === tight.surface && tight.sidebar === tight.surface && tight.titleBorder === '0px' && tight.editorBorder === '0px',
    `Editing must sit flush with Nendo, on its surface colour, with no boxes or paper margins: ${JSON.stringify(tight)}.`);
  // The divider drags with a real pointer, and moves with the keyboard.
  const split = () => frame.evaluate(() => {
    const panes = document.getElementById('panes').getBoundingClientRect(), editor = document.getElementById('editor-wrap').getBoundingClientRect();
    return { share: (editor.width + 6) / panes.width, value: Number(document.getElementById('splitter').getAttribute('aria-valuenow')), left: panes.left, width: panes.width };
  });
  const handle = await frame.locator('#splitter').boundingBox();
  const before = await split();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.left + before.width * 0.7, handle.y + handle.height / 2, { steps: 10 });
  await page.mouse.up();
  const dragged = await split();
  assert(Math.abs(dragged.share - 0.7) < 0.04 && dragged.value === 70, `Dragging the divider to 70% must give the editor 70%: ${JSON.stringify({ before, dragged })}.`);
  await frame.locator('#splitter').focus();
  await page.keyboard.press('ArrowLeft');
  assert((await split()).value === 65, 'Left arrow on the divider must narrow the editor by five points.');
  await page.keyboard.press('End');
  assert((await split()).value === 100 && !await visible('#preview'), 'End on the divider folds the preview away.');
  await frame.locator('#splitter').dblclick();
  assert((await split()).value === 50 && await visible('#preview'), 'A double-click on the divider shares the width evenly again.');
  await page.screenshot({ path: '__OUTPUT__/editing.png', fullPage: true });
  checks.push('editing fills the view, divider drags');
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
  await frame.waitForFunction(() => !window.garden.dirty && window.garden.undo.length === 2);
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
  await frame.waitForFunction(() => !window.garden.dirty && window.garden.undo.length === 3);
  const after = await records('gd.link');
  assert(!after.some(l => l.values[F.to] === stub.recordId), 'The removed wikilink\'s row must be deleted.');
  assert((await records('gd.note')).some(n => n.recordId === stub.recordId), 'The planted seed stays when its link goes.');
  assert(after.filter(l => l.values[F.source] === 'Manual').length === manualBefore && manualBefore > 0, 'A Manual link is never touched by a save.');
  checks.push('link removal keeps Manual rows');

  // 6. Tick the checkbox: the same task row is updated, by its key.
  await frame.evaluate(() => { const e = document.getElementById('editor'); e.value = e.value.replace('- [ ] Water the seeds', '- [x] Water the seeds'); e.dispatchEvent(new Event('input', { bubbles: true })); });
  await command('save');
  await frame.waitForFunction(() => !window.garden.dirty && window.garden.undo.length === 4);
  const ticked = (await records('gd.task')).find(t => t.recordId === task.recordId);
  assert(ticked && ticked.values[F.taskDone] === true, 'Ticking must update the same task record (matched by key), not make another.');
  assert((await records('gd.task')).filter(t => t.values[F.taskTitle] === 'Water the seeds').length === 1, 'One task row per checkbox.');
  checks.push('checkbox done by key');

  // 7. Undo takes the last save back as one step.
  const undosBefore = await requests('records.undo');
  await command('undo');
  await frame.waitForFunction(() => window.garden.undo.length === 3);
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
  assert(firstRow.includes(into[0].labels[F.from]) && firstRow.includes(into[0].values[F.context].slice(-20)), 'A backlink row names its source note and its sentence: ' + firstRow);
  assert(await frame.locator('#panel-tasks li').count() === fixture.records['gd.task'].filter(t => t.values[F.taskNote] === 'gd.note.how-links-work').length || await frame.locator('#panel-tasks li.none').count() === 1, 'The panel lists the note\'s tasks or says there are none.');
  const openedBefore = (await page.evaluate(() => window.broker.opened())).length;
  await frame.locator('#panel-backlinks li button').first().click();
  await page.waitForTimeout(100);
  const opened = await page.evaluate(() => window.broker.opened());
  assert(opened.length === openedBefore + 1 && opened.at(-1).entityId === 'gd.note' && opened.at(-1).recordId === into[0].values[F.from], 'A backlink row opens its source note, exactly once.');
  checks.push('backlinks panel');

  // 12. The Graph screen: d3 lays the notes out, and a real pointer hovers, drags, zooms and opens.
  const graphContext = { ...fixture.context, viewId: 'gd.note.graph', kind: 'extensionGraphSurface', title: 'Graph',
    bindings: { labelFieldId: 'gd.note.title', statusFieldId: 'gd.note.stage', edgeEntityId: 'gd.link', sourceFieldId: 'gd.link.from', targetFieldId: 'gd.link.to', fields: [], filters: [] } };
  await page.evaluate(({ fixture, graphContext }) => { window.broker.setFixture({ ...fixture, context: graphContext }); window.broker.remount(); }, { fixture, graphContext });
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.gardenGraph?.ready === true, { timeout: 15000 });
  const pairs = new Set(fixture.records['gd.link'].filter(l => l.values[F.from] !== l.values[F.to]).map(l => `${l.values[F.from]}>${l.values[F.to]}`));
  assert(await frame.locator('#graph-canvas .node').count() === seedNotes, `The graph draws every note: ${seedNotes}.`);
  assert(await frame.locator('#graph-canvas line.edge').count() === pairs.size, `The graph draws one edge per linked pair and direction: ${pairs.size}.`);
  assert((await page.evaluate(() => window.broker.chromeRefusals)).length === 0, 'Nendo refused a graph toolbar declaration: ' + JSON.stringify(await page.evaluate(() => window.broker.chromeRefusals)));
  assert(await frame.locator('.nendo-kit-text-alternative li').count() === seedNotes, 'A screen reader reads every note and its links as text.');
  await page.waitForTimeout(1600);
  const centre = id => frame.evaluate(id => { const b = document.querySelector(`#graph-canvas .node[data-id="${id}"] circle`).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, id);
  const laid = await frame.evaluate(() => { const xs = [], ys = []; for (const c of document.querySelectorAll('#graph-canvas .node circle')) { const b = c.getBoundingClientRect(); xs.push(b.x); ys.push(b.y); } return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; });
  assert(laid.w > 120 && laid.h > 60, `The force layout must spread the notes out: ${JSON.stringify(laid)}.`);
  // Hover lights a note and its neighbours and dims the rest.
  const template = await centre('gd.note.daily-note-template');
  await page.mouse.move(template.x, template.y);
  await page.waitForTimeout(300);
  const dim = await frame.evaluate(() => ({ focusing: document.querySelector('#graph-canvas svg').classList.contains('focusing'),
    other: Number(getComputedStyle(document.querySelector('#graph-canvas .node[data-id="gd.note.for-agents"]')).opacity),
    neighbour: Number(getComputedStyle(document.querySelector('#graph-canvas .node[data-id="gd.note.daily-notes"]')).opacity) }));
  assert(dim.focusing && dim.other < 0.5 && dim.neighbour > 0.9, `Hover must light the note's neighbours and dim the rest: ${JSON.stringify(dim)}.`);
  // A drag moves the note, and opens nothing.
  const openedBeforeDrag = (await page.evaluate(() => window.broker.opened())).length;
  await page.mouse.down();
  await page.mouse.move(template.x + 150, template.y + 90, { steps: 12 });
  const held = await centre('gd.note.daily-note-template');
  await page.mouse.up();
  assert(Math.hypot(held.x - template.x, held.y - template.y) > 80, `Dragging must move the note with the pointer: from ${JSON.stringify(template)} to ${JSON.stringify(held)}.`);
  assert((await page.evaluate(() => window.broker.opened())).length === openedBeforeDrag, 'A drag must not open the note.');
  // The wheel zooms.
  const k0 = await frame.evaluate(() => window.gardenGraph.state().k);
  await page.mouse.move(40, 120);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(250);
  const k1 = await frame.evaluate(() => window.gardenGraph.state().k);
  assert(k1 > k0 * 1.2, `The wheel must zoom in: ${k0} to ${k1}.`);
  // A click opens the note, exactly once. Fit first: zooming at the edge can carry it out of sight.
  await command('fit');
  await page.waitForTimeout(1200);
  const start = await centre('gd.note.start-here');
  const viewport = page.viewportSize();
  assert(start.x > 0 && start.y > 0 && start.x < viewport.width && start.y < viewport.height, `Fit must bring every note into sight: ${JSON.stringify(start)}.`);
  await page.mouse.click(start.x, start.y);
  await page.waitForTimeout(150);
  const graphOpened = await page.evaluate(() => window.broker.opened());
  assert(graphOpened.length === openedBeforeDrag + 1 && graphOpened.at(-1).recordId === 'gd.note.start-here' && graphOpened.at(-1).entityId === 'gd.note', 'A click on a note opens it, exactly once: ' + JSON.stringify(graphOpened.slice(openedBeforeDrag)));
  // Find picks out a note; Tags adds the tags as nodes; the colour is the stage's tone.
  await command('find', 'agents');
  await page.waitForTimeout(100);
  assert(await frame.locator('#graph-canvas .node.match').count() === 1, 'Find must pick out For agents.');
  await command('find', '');
  await command('tags', true);
  await frame.waitForFunction(count => document.querySelectorAll('#graph-canvas .node').length === count, seedNotes + fixture.records['gd.tag'].length, { timeout: 5000 })
    .catch(async () => { throw Error(`Tags must add the ${fixture.records['gd.tag'].length} tags as nodes: ${await frame.locator('#graph-canvas .node').count()}.`); });
  const graphColours = {};
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => window.broker.pushTheme(mode), mode); await page.waitForTimeout(150);
    graphColours[mode] = await frame.evaluate(() => {
      const token = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      return { evergreen: getComputedStyle(document.querySelector('#graph-canvas .node[data-id="gd.note.start-here"] circle')).fill, green: token('tone-green'),
        growing: getComputedStyle(document.querySelector('#graph-canvas .node[data-id="gd.note.daily-notes"] circle')).fill, teal: token('tone-teal') };
    });
    assert(graphColours[mode].evergreen === graphColours[mode].green && graphColours[mode].growing === graphColours[mode].teal, `${mode}: a note is drawn in its stage's tone: ${JSON.stringify(graphColours[mode])}`);
    await page.mouse.move(2, 2); await page.waitForTimeout(250);
    await page.screenshot({ path: '__OUTPUT__/graph-' + mode + '.png', fullPage: true });
  }
  assert(graphColours.light.evergreen !== graphColours.dark.evergreen, 'The graph follows the theme.');
  checks.push('graph screen');

  // 13. Narrow: the sidebar stacks above the editor and nothing scrolls sideways.
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
