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
  const localToday = () => { const d = new Date(), pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
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
  await command('width-narrow', true);
  const narrowSheet = await sheet();
  assert(narrowSheet.width <= 760 && Math.abs(narrowSheet.left - narrowSheet.right) <= 2, `Narrow must keep a centred column of at most 760 px: ${JSON.stringify(narrowSheet)}.`);
  await command('width-medium', true);
  const mediumSheet = await sheet();
  assert(mediumSheet.width > narrowSheet.width && mediumSheet.width <= 1120, `Medium must sit between Narrow and Full: ${JSON.stringify(mediumSheet)}.`);
  const widthGroup = () => page.evaluate(() => window.broker.toolbars.at(-1).items.find(i => i.kind === 'group' && i.label === 'Width'));
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.some(i => i.kind === 'group' && i.label === 'Width' && i.items.find(t => t.id === 'width-medium')?.pressed === true), null, { timeout: 2000 })
    .catch(async () => { throw Error('Nendo\'s row must show the width chosen: ' + JSON.stringify(await widthGroup())); });
  const group = await widthGroup();
  assert(JSON.stringify(group.items.map(t => [t.kind, t.icon, t.iconOnly])) === JSON.stringify([['toggle', 'widthNarrow', true], ['toggle', 'widthMedium', true], ['toggle', 'widthFull', true]]),
    'The width is three icon-only toggles: ' + JSON.stringify(group.items));
  // A Nendo without the width icons refuses the row; the view says the width in words instead.
  await page.evaluate(() => window.broker.fail('ui.setToolbar', { code: 'invalid-params', message: "items[5].items[0].icon must be one of Nendo's icons." }, 1));
  await command('width-full', true);
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.some(i => i.id === 'width' && i.kind === 'choice' && i.value === 'full' && i.options.map(o => o.label).join() === 'Narrow,Medium,Full'), null, { timeout: 2000 })
    .catch(async () => { throw Error('On a Nendo without the width icons the width must be a choice of words: ' + JSON.stringify((await page.evaluate(() => window.broker.toolbars.at(-1))).items.map(i => i.id ?? i.label))); });
  assert(await frame.evaluate(() => document.documentElement.classList.contains('native-chrome')), 'A refused icon must not cost the view Nendo\'s row.');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '__OUTPUT__/reading.png', fullPage: true });
  checks.push('opens for reading');

  // The local graph: the note and every note one link away, either way.
  const near = new Set(['gd.note.start-here']);
  for (const l of fixture.records['gd.link']) { if (l.values[F.from] === 'gd.note.start-here') near.add(l.values[F.to]); if (l.values[F.to] === 'gd.note.start-here') near.add(l.values[F.from]); }
  await frame.waitForFunction(count => document.querySelectorAll('#local-graph .node').length === count, near.size, { timeout: 5000 }).catch(async () => { throw Error(`The local graph must draw ${near.size} notes, drew ${await frame.locator('#local-graph .node').count()}.`); });
  assert(await frame.locator('#local-graph .node.current[data-id="gd.note.start-here"]').count() === 1, 'The local graph marks the note it is about.');
  // Connections: the links out are listed beside the links in, and the graph sits beside the rows in a
  // box its notes fill, not a full-width band of empty grey (the owner's report, 2026-10-07).
  const outOf = fixture.records['gd.link'].filter(l => l.values[F.from] === 'gd.note.start-here').length;
  assert(await frame.locator('#outlinks li button').count() === outOf, `Links to must list the ${outOf} links out of Start here.`);
  assert(await frame.locator('#local-open-graph').isHidden(), 'A host that offers no ui.openScreen gets no Open the graph button.');
  await page.waitForTimeout(900);
  const room = await frame.evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const host = rect('local-graph'), rows = rect('connections-lists');
    const boxes = [...document.querySelectorAll('#local-graph .node')].map(node => node.getBoundingClientRect());
    const drawn = { w: Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.left)), h: Math.max(...boxes.map(b => b.bottom)) - Math.min(...boxes.map(b => b.top)) };
    const label = Math.max(...[...document.querySelectorAll('#local-graph .node .label')].map(text => text.getBoundingClientRect().height));
    return { width: Math.round(host.width), height: Math.round(host.height), rows: Math.round(rows.height), label: Math.round(label), filled: +(drawn.w * drawn.h / (host.width * host.height)).toFixed(3),
      beside: host.left >= rows.right - 1 && host.top < rows.bottom };
  });
  // As tall as the rows beside it (the owner's second report, 2026-10-07), and never under 220 px.
  assert(room.beside && room.width >= 520 && room.width <= 900 && room.height >= 220 && room.height >= room.rows - 2 && room.filled >= 0.1 && room.label <= 22,
    `The local graph must sit beside the link rows, 520 to 900 px wide, as tall as the rows and at least 220 px, with its notes filling at least 10% of it and labels no taller than 22 px: ${JSON.stringify(room)}.`);
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
  // The place is declared once the note is shown, a moment after it is chosen: wait for it, then assert.
  await page.waitForFunction(() => window.broker.places.some(p => p.place.noteId === 'gd.note.how-links-work'), null, { timeout: 3000 }).catch(() => {});
  const places = await page.evaluate(() => window.broker.places);
  assert(places.some(p => p.place.noteId === 'gd.note.how-links-work' && p.label === 'How links work' && !p.replace), 'Following a wikilink must declare a new place named after the note: ' + JSON.stringify(places));
  checks.push('wikilink navigation and places');

  // The tree folds. The arrow beside a note with notes under it folds the branch away under a real
  // pointer and opens nothing; Right and Left unfold, step in, step up and fold; the fold is kept;
  // and following a link to a note in a folded branch unfolds it.
  const rowCount = () => frame.locator('#tree .row').count();
  const expanded = id => frame.evaluate(id => document.querySelector(`#tree .row[data-id="${id}"]`)?.parentElement.getAttribute('aria-expanded') ?? null, id);
  const placesBeforeFold = (await page.evaluate(() => window.broker.places)).length;
  assert(await expanded('gd.note.start-here') === 'true' && await rowCount() === seedNotes, 'A branch starts unfolded.');
  const twisty = await frame.locator('#tree .row[data-id="gd.note.start-here"] .twisty').boundingBox();
  await page.mouse.click(twisty.x + twisty.width / 2, twisty.y + twisty.height / 2);
  await frame.waitForFunction(() => document.querySelectorAll('#tree .row').length === 1, null, { timeout: 2000 })
    .catch(async () => { throw Error(`The arrow must fold the branch away: ${await rowCount()} rows.`); });
  const folded = { expanded: await expanded('gd.note.start-here'), note: (await state()).note, places: (await page.evaluate(() => window.broker.places)).length,
    kept: await frame.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('garden.tree.collapsed'))?.[1] ?? null) };
  assert(folded.expanded === 'false' && folded.note === 'gd.note.how-links-work' && folded.places === placesBeforeFold && folded.kept?.includes('gd.note.start-here'),
    `Folding opens nothing and is kept: ${JSON.stringify(folded)}.`);
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').focus();
  await page.keyboard.press('ArrowRight');
  assert(await rowCount() === seedNotes && await expanded('gd.note.start-here') === 'true', 'Right must unfold a folded branch.');
  await page.keyboard.press('ArrowRight');
  const stepped = await frame.evaluate(() => document.activeElement?.dataset.id);
  assert(stepped === 'gd.note.how-links-work', `Right on an unfolded branch must step to its first note: ${stepped}.`);
  await page.keyboard.press('ArrowLeft');
  assert(await frame.evaluate(() => document.activeElement?.dataset.id) === 'gd.note.start-here', 'Left must step up to the note a note is under.');
  await page.keyboard.press('ArrowLeft');
  assert(await rowCount() === 1 && await expanded('gd.note.start-here') === 'false', 'Left on an unfolded branch must fold it.');
  await frame.locator('#reading-body a.wikilink[data-id="gd.note.start-here"]').first().click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here');
  assert(await rowCount() === 1, 'Opening a note at the top leaves a folded branch folded.');
  await frame.locator('#reading-body a.wikilink[data-id="gd.note.how-links-work"]').first().click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.how-links-work');
  assert(await rowCount() === seedNotes && await frame.locator('#tree .row[aria-current=true][data-id="gd.note.how-links-work"]').count() === 1,
    'Opening a note in a folded branch must unfold it and show the note as current.');
  await command('collapse-all');
  assert(await rowCount() === 1, 'Collapse all must fold every branch.');
  await command('expand-all');
  assert(await rowCount() === seedNotes, 'Expand all must unfold every branch.');
  checks.push('tree folds');

  // The line between the tree and the page drags with a real pointer, moves with the keys and resets on a double-click.
  const treeSide = () => frame.evaluate(() => ({ sidebar: document.getElementById('sidebar').getBoundingClientRect().width, mainLeft: document.getElementById('main').getBoundingClientRect().left,
    value: Number(document.getElementById('tree-splitter').getAttribute('aria-valuenow')), kept: localStorage.getItem('garden.treeWidth') }));
  const treeBefore = await treeSide();
  assert(treeBefore.sidebar === 250 && treeBefore.mainLeft === 250, `The tree starts 250 px wide: ${JSON.stringify(treeBefore)}.`);
  const grip = await frame.locator('#tree-splitter').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 400);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 150, grip.y + 400, { steps: 10 });
  await page.mouse.up();
  const treeDragged = await treeSide();
  assert(Math.abs(treeDragged.sidebar - 400) <= 2 && Math.abs(treeDragged.mainLeft - treeDragged.sidebar) <= 1 && treeDragged.value === Math.round(treeDragged.sidebar) && treeDragged.kept === String(treeDragged.value),
    `Dragging the line 150 px right must widen the tree to 400 px and keep it: ${JSON.stringify({ treeBefore, treeDragged })}.`);
  assert((await state()).note === 'gd.note.how-links-work', 'Dragging the line opens nothing.');
  await frame.locator('#tree-splitter').focus();
  await page.keyboard.press('ArrowLeft');
  assert((await treeSide()).value === treeDragged.value - 16, 'Left on the line must narrow the tree by 16 px.');
  await page.keyboard.press('Home');
  assert((await treeSide()).sidebar === 160, 'Home on the line narrows the tree to its least.');
  await frame.locator('#tree-splitter').dblclick();
  const treeReset = await treeSide();
  assert(treeReset.sidebar === 250 && treeReset.kept === '250', `A double-click on the line resets the tree to 250 px: ${JSON.stringify(treeReset)}.`);
  checks.push('tree divider drags');

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
  assert(saved.values[F.body].includes('[[daily-notes]]') && saved.values[F.touched] === localToday(), 'The body and the touched date must be stored, as the local calendar day.');
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

  // 14. A save on its way (review R-005): what is typed meanwhile stays a draft, a second Save
  // writes nothing more, a note gone to meanwhile is not replaced, and a note read late never lands.
  await page.setViewportSize({ width: 1440, height: 900 });

  // The Garden guide: Nendo's row toggles it; it opens beside the page with focus on it, counts this
  // garden, scrolls to a section from its contents, follows the theme, closes on Esc, and a way in acts.
  await command('about', true);
  await frame.waitForFunction(() => !document.getElementById('guide').hidden, null, { timeout: 2000 }).catch(() => { throw Error('Garden guide must open from Nendo\'s row.'); });
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.find(i => i.id === 'about')?.pressed === true, null, { timeout: 2000 })
    .catch(async () => { throw Error('Nendo\'s row must show the guide as open: ' + JSON.stringify((await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(i => i.id === 'about'))); });
  await page.waitForTimeout(700);
  // The stage bars grow over a 0.6 s transition, which a busy or hidden browser runs late: wait for
  // them to fill their track rather than for a fixed time, and let the assertion below say if they never do.
  await frame.waitForFunction(() => {
    const bars = [...document.querySelectorAll('.stage-bar')].reduce((sum, bar) => sum + bar.getBoundingClientRect().width, 0);
    return Math.abs(bars - document.querySelector('.guide-stages').getBoundingClientRect().width) <= 2;
  }, null, { timeout: 3000 }).catch(() => {});
  const guideOpen = await frame.evaluate(() => { const box = document.getElementById('guide').getBoundingClientRect();
    const stat = name => Number(document.querySelector(`[data-stat=${name}]`).textContent.replace(/\D/g, ''));
    const bars = [...document.querySelectorAll('.stage-bar')].reduce((sum, bar) => sum + bar.getBoundingClientRect().width, 0);
    return { sections: document.querySelectorAll('#guide .guide-section').length, notes: stat('notes'), links: stat('links'), tags: stat('tags'),
      focus: document.activeElement?.id, right: innerWidth - box.right, width: box.width, bars, track: document.querySelector('.guide-stages').getBoundingClientRect().width,
      picks: document.querySelectorAll('#guide-picks li button').length, note: window.garden.note?.recordId }; });
  const notesNow = (await records('gd.note')).length, linksNow = (await records('gd.link')).length, tagsNow = (await records('gd.tag')).length;
  assert(guideOpen.sections >= 7 && guideOpen.notes === notesNow && guideOpen.links === linksNow && guideOpen.tags === tagsNow && guideOpen.focus === 'guide' && Math.abs(guideOpen.right) <= 1
    && guideOpen.width >= 400 && Math.abs(guideOpen.bars - guideOpen.track) <= 2 && guideOpen.picks >= 1 && guideOpen.note === 'gd.note.start-here',
    `The guide must open beside the page and count this garden (${notesNow} notes, ${linksNow} links, ${tagsNow} tags): ${JSON.stringify(guideOpen)}.`);
  const keysLink = await frame.locator('.guide-toc a[href="#guide-keys"]').boundingBox();
  await page.mouse.click(keysLink.x + keysLink.width / 2, keysLink.y + keysLink.height / 2);
  await page.waitForTimeout(700);
  // A smooth scroll a busy browser runs late: wait for it to arrive, and let the assertion say if it never does.
  await frame.waitForFunction(() => {
    const scroller = document.querySelector('.guide-body'), body = scroller.getBoundingClientRect(), keys = document.getElementById('guide-keys').getBoundingClientRect();
    const atEnd = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
    return scroller.scrollTop > 0 && (Math.abs(keys.top - body.top) <= 8 || (atEnd && keys.top >= body.top - 1 && keys.bottom <= body.bottom + 1));
  }, null, { timeout: 3000 }).catch(() => {});
  const scrolled = await frame.evaluate(() => { const body = document.querySelector('.guide-body').getBoundingClientRect(), keys = document.getElementById('guide-keys').getBoundingClientRect();
    const scroller = document.querySelector('.guide-body');
    return { offset: keys.top - body.top, scrollTop: scroller.scrollTop, atEnd: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1, inView: keys.top >= body.top - 1 && keys.bottom <= body.bottom + 1 }; });
  // Keys sits near the end: it either reaches the top, or the guide scrolls to its end with Keys whole in view.
  assert(scrolled.scrollTop > 0 && (Math.abs(scrolled.offset) <= 8 || (scrolled.atEnd && scrolled.inView)), `The contents must scroll the guide to Keys: ${JSON.stringify(scrolled)}.`);
  const guideColours = {};
  for (const mode of ['dark', 'light']) {
    await page.evaluate(mode => window.broker.pushTheme(mode), mode); await page.waitForTimeout(150);
    guideColours[mode] = await frame.evaluate(() => {
      const token = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      const guide = document.getElementById('guide');
      return { background: getComputedStyle(guide).backgroundColor, raised: (() => { const e = document.createElement('i'); e.style.color = 'var(--nendo-surface-raised)'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })(),
        ink: getComputedStyle(guide).color, evergreen: getComputedStyle(document.querySelector('.stage-bar.evergreen')).backgroundColor, green: token('tone-green') };
    });
    assert(guideColours[mode].background === guideColours[mode].raised && guideColours[mode].evergreen === guideColours[mode].green, `${mode}: the guide is drawn in the theme's tokens: ${JSON.stringify(guideColours[mode])}`);
    await frame.locator('.guide-body').evaluate(body => { body.style.scrollBehavior = 'auto'; body.scrollTop = 0; body.style.scrollBehavior = ''; });
    await page.waitForTimeout(150);
    await page.screenshot({ path: '__OUTPUT__/guide-' + mode + '.png', fullPage: true });
  }
  assert(guideColours.light.background !== guideColours.dark.background && guideColours.light.ink !== guideColours.dark.ink, 'The guide follows the theme.');
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => document.getElementById('guide').hidden, null, { timeout: 2000 }).catch(() => { throw Error('Esc must close the guide.'); });
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.find(i => i.id === 'about')?.pressed === false, null, { timeout: 2000 })
    .catch(() => { throw Error('Nendo\'s row must show the guide as closed after Esc.'); });
  await command('about', true);
  await frame.waitForFunction(() => !document.getElementById('guide').hidden);
  const plant = await frame.locator('#guide button[data-guide="new"]').first().boundingBox();
  await page.mouse.click(plant.x + plant.width / 2, plant.y + plant.height / 2);
  await frame.waitForFunction(() => document.getElementById('guide').hidden && window.garden.note === null && window.garden.mode === 'edit', null, { timeout: 2000 })
    .catch(async () => { throw Error('Plant one now must close the guide and open a new note in Edit: ' + JSON.stringify(await frame.evaluate(() => ({ hidden: document.getElementById('guide').hidden, mode: window.garden.mode, note: window.garden.note?.recordId ?? null })))); });
  checks.push('Garden guide');

  await frame.evaluate(() => localStorage.clear());
  await page.evaluate(fixture => { window.broker.setFixture(fixture); window.broker.remount(); }, fixture);
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.garden?.ready === true && window.garden.note?.recordId === 'gd.note.start-here' && !window.garden.dirty);
  const type = text => frame.evaluate(text => { const e = document.getElementById('editor'); e.value = text; e.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  const editorText = () => frame.evaluate(() => document.getElementById('editor').value);
  const storedBody = async id => (await records('gd.note')).find(n => n.recordId === id)?.values[F.body];
  const settled = () => frame.waitForFunction(() => window.garden.saving === false, { timeout: 5000 });
  await command('mode', 'edit');
  await frame.waitForFunction(() => window.garden.mode === 'edit');
  await type('REVIEW saved A');
  const slowBefore = await requests('records.batch');
  await page.evaluate(() => window.broker.hold('records.batch', 900));
  await command('save');
  await page.waitForFunction(n => window.broker.requests.filter(r => r.m === 'records.batch').length === n, slowBefore + 1);
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.find(i => i.id === 'save')?.disabled === true, null, { timeout: 2000 })
    .catch(() => { throw Error('Save must be disabled while a save is on its way.'); });
  await type('REVIEW newer B typed while saving');
  await settled();
  await page.waitForTimeout(100);
  const afterSlow = { editor: await editorText(), stored: await storedBody('gd.note.start-here'), ...(await state()) };
  assert(afterSlow.stored === 'REVIEW saved A' && afterSlow.editor === 'REVIEW newer B typed while saving' && afterSlow.dirty === true && afterSlow.external === false,
    `Typing that arrives while a save travels must stay a draft over the saved text: ${JSON.stringify(afterSlow)}.`);
  checks.push('typing during a save stays a draft');

  // Two presses of Save on a new note make one note.
  await command('new');
  await frame.evaluate(() => { const t = document.getElementById('title'); t.value = 'Fresh once'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await type('Planted only once.');
  const doubleBefore = await requests('records.batch');
  await page.evaluate(() => window.broker.hold('records.batch', 600));
  await command('save');
  await command('save');
  await page.waitForTimeout(150);
  await settled();
  assert(await requests('records.batch') === doubleBefore + 1, 'A second Save while the first travels must send nothing.');
  assert((await records('gd.note')).filter(n => n.values['gd.note.title'] === 'Fresh once').length === 1, 'Two presses of Save must plant one note.');
  checks.push('double Save writes once');

  // A save answered after the person went to another note leaves them there.
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here' && window.garden.dirty);
  await page.evaluate(() => window.broker.hold('records.batch', 900));
  await command('save');
  await page.waitForTimeout(100);
  await frame.locator('#tree .row[data-id="gd.note.how-links-work"]').click();
  await settled();
  await page.waitForTimeout(200);
  const away = { note: (await state()).note, editor: await editorText(), stored: await storedBody('gd.note.start-here'), draftRow: await frame.locator('#tree .row.draft[data-id="gd.note.start-here"]').count() };
  assert(away.note === 'gd.note.how-links-work' && !away.editor.includes('REVIEW') && away.stored === 'REVIEW newer B typed while saving' && away.draftRow === 0,
    `A save answered after the person moved on must not take them back or leave a spent draft: ${JSON.stringify(away)}.`);
  checks.push('save answered after moving on');

  // Two notes read in reverse order: the one gone to last is the one shown.
  await page.evaluate(() => window.broker.hold('records.get', 700));
  await frame.locator('#tree .row[data-id="gd.note.daily-notes"]').click();
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').click();
  await page.waitForTimeout(1100);
  const lastWins = { note: (await state()).note, editor: await editorText() };
  assert(lastWins.note === 'gd.note.start-here' && lastWins.editor === 'REVIEW newer B typed while saving', `The note gone to last must win over a slower read: ${JSON.stringify(lastWins)}.`);
  checks.push('last note opened wins');

  // 15. A save Nendo never answered (review R-011): saying so, and sending it again, keeps it once.
  await command('new');
  await frame.evaluate(() => { const t = document.getElementById('title'); t.value = 'Unanswered seed'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await type('Kept once, whatever the wire did.');
  await page.evaluate(() => window.broker.drop('records.batch', { code: 'host-timeout', message: 'The Desktop host did not respond.' }));
  await command('save');
  await frame.waitForFunction(() => window.garden.saving === false && window.garden.problem !== null);
  const lost = await frame.evaluate(() => window.garden.problem);
  assert(/did not answer/.test(lost) && !/refused/.test(lost), `An unanswered save must not be called refused: ${lost}`);
  await command('save');
  await frame.waitForFunction(() => window.garden.saving === false && window.garden.dirty === false, { timeout: 5000 });
  const sent = await page.evaluate(() => window.broker.requests.filter(r => r.m === 'records.batch').slice(-2).map(r => r.p.writeKey));
  assert(sent[0] && sent[0] === sent[1], `Saving again must send the same batch under the same writeKey: ${JSON.stringify(sent)}.`);
  assert((await records('gd.note')).filter(n => n.values['gd.note.title'] === 'Unanswered seed').length === 1, 'An unanswered create saved again must make one note.');
  checks.push('unanswered save kept once');

  // 16. Drafts outlast the view (review R-001): two dirty notes, the frame started again, both back.
  await frame.locator('#tree .row[data-id="gd.note.start-here"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.start-here');
  await type('REVIEW unsaved D');
  await frame.locator('#tree .row[data-id="gd.note.daily-notes"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.daily-notes');
  await type('REVIEW unsaved E');
  await page.waitForTimeout(400);
  const batchesBeforeRemount = await requests('records.batch');
  await page.evaluate(() => window.broker.remount());
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.garden?.ready === true && window.garden.note?.recordId === 'gd.note.start-here');
  const recovered = { editor: await editorText(), dirty: (await state()).dirty, marked: await frame.locator('#tree .row.draft[data-id="gd.note.daily-notes"]').count(),
    status: await frame.locator('#status').textContent(), stored: await storedBody('gd.note.start-here') };
  assert(recovered.editor === 'REVIEW unsaved D' && recovered.dirty === true && recovered.marked === 1 && /kept from before/.test(recovered.status) && recovered.stored !== 'REVIEW unsaved D',
    `Both unsaved drafts must come back after the view starts again, unsaved: ${JSON.stringify(recovered)}.`);
  await frame.locator('#tree .row[data-id="gd.note.daily-notes"]').click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.daily-notes');
  assert(await editorText() === 'REVIEW unsaved E', 'The second draft must come back too.');
  assert(await requests('records.batch') === batchesBeforeRemount, 'Keeping drafts must never save them.');
  checks.push('drafts outlast the view');

  // 17. Find searches the file's own index (ADR-0028): a word that only one note's body says finds
  // that note and no other, in bold in the tree; opened, the note shows the word highlighted in the
  // reading view, and in Edit on the layer behind the editor, laid out as the editor lays out its
  // text; and with no index the view still finds the note in the bodies it holds.
  await page.evaluate(fixture => { window.broker.offerSearch(true); window.broker.setFixture(fixture); window.broker.remount(); }, fixture);
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.garden?.ready === true, null, { timeout: 15000 });
  const seedNotesNow = await records('gd.note');
  const tokensOf = value => String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const holders = word => seedNotesNow.filter(n => Object.values(n.values).some(v => typeof v === 'string' && tokensOf(v).some(t => t.startsWith(word))));
  const plainly = word => seedNotesNow.filter(n => `${n.values['gd.note.title'] ?? ''}\n${n.values[F.slug] ?? ''}\n${n.values[F.body] ?? ''}`.toLowerCase().includes(word));
  const bodyWord = [...new Set(seedNotesNow.flatMap(n => tokensOf(n.values[F.body])))].filter(w => w.length >= 6 && /^\p{L}+$/u.test(w))
    .find(w => holders(w).length === 1 && plainly(w).length === 1 &&
      !`${holders(w)[0].values['gd.note.title']}\n${holders(w)[0].values[F.slug]}`.toLowerCase().includes(w));
  assert(bodyWord, 'The seed must hold a word that only one note body says.');
  const holder = holders(bodyWord)[0].recordId;
  const searchesBefore = await requests('records.search');
  await command('find', bodyWord);
  await frame.waitForFunction(() => window.garden.findSource === 'index', null, { timeout: 3000 })
    .catch(async () => { throw Error(`Find must be answered by the index: ${await frame.evaluate(() => window.garden.findSource)}.`); });
  const found = await frame.evaluate(() => ({ matches: [...document.querySelectorAll('#tree .row.match')].map(r => r.dataset.id),
    excerpts: document.querySelectorAll('#tree .row mark, #tree .row .hit').length }));
  assert(found.matches.length === 1 && found.matches[0] === holder && found.excerpts === 0,
    `Find "${bodyWord}" must mark ${holder} alone in the tree, with no excerpt there: ${JSON.stringify(found)}.`);
  assert(await requests('records.search') > searchesBefore, 'Find must ask Nendo to search.');
  await frame.locator(`#tree .row[data-id="${holder}"]`).click();
  await frame.waitForFunction(id => window.garden.note?.recordId === id && window.garden.findMarks.text > 0, holder, { timeout: 3000 })
    .catch(async () => { throw Error(`Opening ${holder} must mark "${bodyWord}" in the note: ${JSON.stringify(await frame.evaluate(() => window.garden.findMarks))}.`); });
  const reading = await frame.evaluate(() => {
    const highlight = CSS.highlights.get('garden-find');
    const ranges = highlight ? [...highlight] : [];
    const body = document.getElementById('reading-body').getBoundingClientRect();
    const first = ranges[0]?.getBoundingClientRect();
    return { words: ranges.map(range => range.toString().toLowerCase()), inReading: ranges.every(range => ['reading-title', 'reading-meta', 'reading-body', 'preview'].some(id => document.getElementById(id).contains(range.startContainer))),
      visible: first !== undefined && first.width > 0 && first.top >= 0 && first.bottom <= innerHeight && first.left >= body.left - 1 };
  });
  assert(reading.words.length > 0 && reading.words.every(word => word.startsWith(bodyWord)) && reading.inReading && reading.visible,
    `The reading view must highlight "${bodyWord}" and bring it into sight: ${JSON.stringify(reading)}.`);
  // A note found by its name (owner, 2026-10-07: "one page is clearly highlighted but another is
  // not"): a word only the title holds is marked in the title, not lost because the body lacks it.
  const titleNote = seedNotesNow.find(n => tokensOf(n.values['gd.note.title']).some(w => w.length >= 4 && !tokensOf(n.values[F.body]).some(b => b.startsWith(w))));
  assert(titleNote, 'The seed must hold a note whose title has a word its body lacks.');
  const titleWord = tokensOf(titleNote.values['gd.note.title']).find(w => w.length >= 4 && !tokensOf(titleNote.values[F.body]).some(b => b.startsWith(w)));
  await command('find', titleWord);
  await frame.waitForFunction(id => document.querySelector(`#tree .row.match[data-id="${id}"]`) !== null, titleNote.recordId, { timeout: 3000 })
    .catch(() => { throw Error(`Find "${titleWord}" must find ${titleNote.recordId} by its title.`); });
  await frame.locator(`#tree .row[data-id="${titleNote.recordId}"]`).click();
  await frame.waitForFunction(id => window.garden.note?.recordId === id, titleNote.recordId, { timeout: 3000 });
  const byTitle = await frame.evaluate(() => [...(CSS.highlights.get('garden-find') ?? [])]
    .filter(range => document.getElementById('reading-title').contains(range.startContainer)).map(range => range.toString().toLowerCase()));
  assert(byTitle.length > 0 && byTitle.every(word => word.startsWith(titleWord)), `A note found by its title must show "${titleWord}" marked in the title: ${JSON.stringify(byTitle)}.`);
  await command('find', bodyWord);
  await frame.locator(`#tree .row[data-id="${holder}"]`).click();
  await frame.waitForFunction(id => window.garden.note?.recordId === id && window.garden.findMarks.text > 0, holder, { timeout: 3000 });
  await command('mode', 'edit');
  await frame.waitForFunction(() => window.garden.mode === 'edit' && window.garden.findMarks.editor > 0, null, { timeout: 3000 })
    .catch(async () => { throw Error(`Edit must mark "${bodyWord}" in the editor: ${JSON.stringify(await frame.evaluate(() => window.garden.findMarks))}.`); });
  const editing = await frame.evaluate(() => {
    const editor = document.getElementById('editor'), layer = document.querySelector('#editor-wrap .find-layer');
    const a = getComputedStyle(editor), b = getComputedStyle(layer);
    const same = ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingRight', 'whiteSpace', 'overflowWrap'].filter(key => a[key] !== b[key] && !(key === 'whiteSpace' && a[key] === 'pre-wrap' && b[key] === 'pre-wrap'));
    const editorBox = editor.getBoundingClientRect(), layerBox = layer.getBoundingClientRect();
    return { words: [...layer.querySelectorAll('mark')].map(mark => mark.textContent.toLowerCase()), differ: same.map(key => `${key}: ${a[key]} / ${b[key]}`),
      width: Math.round(layerBox.width) - editor.clientWidth, left: Math.round(layerBox.left - editorBox.left), behind: Number(getComputedStyle(editor).zIndex) > 0,
      textareaClear: a.backgroundColor === 'rgba(0, 0, 0, 0)', textInLayer: layer.textContent === editor.value + '\n',
      previewMarks: [...(CSS.highlights.get('garden-find') ?? [])].filter(range => document.getElementById('preview').contains(range.startContainer)).length };
  });
  assert(editing.words.length > 0 && editing.words.every(word => word.startsWith(bodyWord)) && editing.differ.length === 0 && Math.abs(editing.width) <= 1
    && Math.abs(editing.left) <= 1 && editing.behind && editing.textareaClear && editing.textInLayer && editing.previewMarks > 0,
    `Edit must mark "${bodyWord}" behind the editor, laid out as the editor lays out its text, and in the preview: ${JSON.stringify(editing)}.`);
  await command('mode', 'read');
  await page.evaluate(() => window.broker.fail('records.search', { code: 'search-index-missing', message: 'This file has no search index yet.' }, 5));
  await command('find', '');
  await command('find', bodyWord);
  await frame.waitForFunction(() => window.garden.findSource === 'search-index-missing', null, { timeout: 3000 })
    .catch(async () => { throw Error(`A file without an index must leave Find to the view: ${await frame.evaluate(() => window.garden.findSource)}.`); });
  const local = await frame.evaluate(() => ({ matches: [...document.querySelectorAll('#tree .row.match')].map(r => r.dataset.id), marks: window.garden.findMarks.text }));
  assert(local.matches.length === 1 && local.matches[0] === holder && local.marks > 0,
    `Without an index, Find must still find ${holder} by its body and mark the word in it: ${JSON.stringify(local)}.`);
  await command('find', '');
  const cleared = await frame.evaluate(() => ({ marks: window.garden.findMarks, highlight: CSS.highlights.has('garden-find') }));
  assert(cleared.marks.text === 0 && cleared.marks.editor === 0 && !cleared.highlight, `An empty Find must clear every mark: ${JSON.stringify(cleared)}.`);
  checks.push('find searches the index and marks the words in the note, and the bodies without one');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, colours, narrow, checks, errors };
}
