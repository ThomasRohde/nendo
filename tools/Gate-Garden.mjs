async page => {
  // A failure names the last check that passed, so a timeout says where it happened.
  const checks = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Leaving a dirty note asks the person; the probe always says yes.
  page.on('dialog', dialog => dialog.accept());
  let settle = null;
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
  // Under the note, nothing the page already says (the owner, 2026-10-07): no rows of links in and out,
  // and no second list of the body's tags, which are pills in the text. Its tasks are listed.
  assert(await frame.locator('#backlinks, #outlinks, #connections-lists').count() === 0, 'Under the note there must be no rows of links: the page and the local graph say them.');
  assert(await frame.locator('#reading-body a.tag').count() > 0 && await frame.locator('#tags-card').isHidden(), 'The body\'s tags are pills in the text, not a second list under the note.');
  // Its tasks are in a grey strip under the title (the owner, 2026-10-08, "Go with B"): how many are
  // done and the next one with its box, its Markdown drawn; no card under the note and no "Checkbox".
  const strip = () => frame.evaluate(() => {
    const s = document.getElementById('task-strip'), rect = e => e.getBoundingClientRect();
    return { shown: !s.hidden && s.getClientRects().length > 0, count: document.getElementById('task-count').textContent,
      next: document.querySelector('#task-next:not([hidden]) .strip-task .text')?.textContent ?? null,
      bold: document.querySelectorAll('#task-strip:not([hidden]) .strip-task .text strong').length,
      finished: !document.getElementById('task-finished').hidden,
      rows: document.querySelectorAll('#task-list:not([hidden]) .strip-task').length,
      expanded: document.getElementById('task-all').getAttribute('aria-expanded'),
      under: rect(s).top >= rect(document.getElementById('reading-meta')).bottom - 0.5 && rect(s).bottom <= rect(document.getElementById('reading-body')).top + 0.5,
      card: document.querySelectorAll('#tasks-card, #note-tasks').length, checkbox: /\bCheckbox\b/.test(document.getElementById('note').innerText) };
  });
  const startTasks = fixture.records['gd.task'].filter(t => t.values['gd.task.note'] === 'gd.note.start-here').length;
  const firstStrip = await strip();
  assert(startTasks === 2 && firstStrip.shown && firstStrip.under && firstStrip.count === '0 of 2 tasks done' && firstStrip.next === 'Plant your first note with New note' && firstStrip.bold === 1
    && !firstStrip.finished && firstStrip.rows === 0 && firstStrip.expanded === 'false' && firstStrip.card === 0 && !firstStrip.checkbox,
    `The note's ${startTasks} tasks must be in the strip between its meta row and its text, the next one with its bold drawn, with no card under the note and no "Checkbox": ${JSON.stringify(firstStrip)}.`);
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
  // Folded until opened, and a folded graph is not drawn (the owner, 2026-10-07: in a dense garden the
  // graph needs room, so it waits behind an expander and opens to the page's width).
  assert(await frame.evaluate(() => !document.getElementById('connections').open) && await frame.locator('#local-graph .node').count() === 0, 'The local graph must be folded, and not drawn, until it is opened.');
  const localCount = await frame.locator('#local-count').textContent();
  assert(localCount === `${near.size - 1} notes one link away`, `The folded graph must say how many notes are one link away: "${localCount}".`);
  await frame.locator('#connections > summary').click();
  await frame.waitForFunction(count => document.querySelectorAll('#local-graph .node').length === count, near.size, { timeout: 5000 }).catch(async () => { throw Error(`The local graph must draw ${near.size} notes, drew ${await frame.locator('#local-graph .node').count()}.`); });
  // Seen almost where it settles (the owner, 2026-10-07: it took long to settle, then snapped to the
  // centre): most of the layout runs before it is drawn and it is framed then, so from the first
  // frame to the settled drawing no note travels far and the drawing ends within two seconds.
  const where = () => frame.evaluate(() => Object.fromEntries([...document.querySelectorAll('#local-graph .node')].map(node => { const b = node.getBoundingClientRect(); return [node.dataset.id, [b.x, b.y]]; })));
  const seen = await where(); await page.waitForTimeout(2000); const still = await where(); await page.waitForTimeout(300); const later = await where();
  const travel = (a, b) => Math.round(Math.max(...Object.keys(a).map(id => Math.hypot(a[id][0] - b[id][0], a[id][1] - b[id][1]))));
  settle = { travelled: travel(seen, still), afterTwoSeconds: travel(still, later) };
  assert(settle.travelled <= 80 && settle.afterTwoSeconds <= 2, `The local graph must be seen near where it settles and be still within two seconds: ${JSON.stringify(settle)}.`);
  assert(await frame.locator('#local-graph .node.current[data-id="gd.note.start-here"]').count() === 1, 'The local graph marks the note it is about.');
  assert(await frame.evaluate(() => localStorage.getItem('garden.localGraph')) === 'open', 'Opening the local graph must be kept in this browser.');
  assert(await frame.locator('#local-open-graph').isHidden(), 'A host that offers no ui.openScreen gets no Open the graph button.');
  await page.waitForTimeout(900);
  const room = await frame.evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const host = rect('local-graph'), about = rect('about');
    const boxes = [...document.querySelectorAll('#local-graph .node')].map(node => node.getBoundingClientRect());
    const drawn = { w: Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.left)), h: Math.max(...boxes.map(b => b.bottom)) - Math.min(...boxes.map(b => b.top)) };
    const label = Math.max(...[...document.querySelectorAll('#local-graph .node .label')].map(text => text.getBoundingClientRect().height));
    const dot = Math.max(...[...document.querySelectorAll('#local-graph .node circle')].map(circle => circle.getBoundingClientRect().width));
    return { width: Math.round(host.width), about: Math.round(about.width), height: Math.round(host.height), label: Math.round(label), dot: Math.round(dot),
      across: +(drawn.w / host.width).toFixed(2), down: +(drawn.h / host.height).toFixed(2),
      inside: boxes.every(b => b.left >= host.left - 1 && b.right <= host.right + 1 && b.top >= host.top - 1 && b.bottom <= host.bottom + 1) };
  });
  // Opened, it takes the page's width and at least 360 px of height, and the notes are spread over
  // it, across more than down (the owner, 2026-10-07: stretched to the room, not a ball in the
  // middle), with dots small enough to leave the names readable and every note inside the box.
  assert(room.width >= room.about - 40 && room.height >= 360 && room.inside && room.label <= 22 && room.dot <= 20 && room.across >= 0.55 && room.down >= 0.4,
    `The opened local graph must take the page's width, be at least 360 px tall, spread its notes over at least 55% of its width and 40% of its height, hold every note inside it, keep dots at most 20 px and labels no taller than 22 px: ${JSON.stringify(room)}.`);
  // Each note takes the tone of its branch, the section of the garden it grows in, and the legend names them.
  const tones = await frame.evaluate(() => {
    const token = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
    const fill = id => getComputedStyle(document.querySelector(`#local-graph .node[data-id="${id}"] circle`)).fill;
    return { first: fill('gd.note.how-links-work'), blue: token('tone-blue'), root: fill('gd.note.start-here'), grey: token('tone-grey'),
      legend: [...document.querySelectorAll('#local-legend .chip')].map(chip => chip.textContent) };
  });
  assert(tones.first === tones.blue && tones.root === tones.grey && JSON.stringify(tones.legend) === JSON.stringify(['How links work', 'Daily notes', 'Tags and tasks', 'For agents']),
    `The local graph colours each note by its branch, the top-level note grey, and names the branches it shows in tree order: ${JSON.stringify(tones)}.`);
  await frame.locator('#connections').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '__OUTPUT__/local-graph.png', fullPage: true });
  checks.push('local graph');

  // Hovering a wikilink previews the note it names.
  const hoverLink = frame.locator('#reading-body a.wikilink[data-id="gd.note.how-links-work"]').first();
  await hoverLink.scrollIntoViewIfNeeded();
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
  const afterTick = await strip();
  assert(afterTick.count === '1 of 2 tasks done' && afterTick.next === 'Link it to this one', `A tick in the text must move the strip on: ${JSON.stringify(afterTick)}.`);
  checks.push('tick while reading');

  // The strip's box works as the text's does, under a real pointer: the line in the body is ticked
  // and saved in one batch, and the strip says every task is done.
  await frame.locator('#task-strip').scrollIntoViewIfNeeded();
  const nextBox = await frame.locator('#task-next .box').boundingBox();
  const stripBefore = await requests('records.batch');
  await page.mouse.click(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
  await frame.waitForFunction(() => window.garden.undo.length === 2 && !window.garden.dirty, null, { timeout: 3000 })
    .catch(async () => { throw Error(`The strip's box must tick and save its task: ${JSON.stringify(await strip())}.`); });
  assert(await requests('records.batch') === stripBefore + 1, 'A tick in the strip must be exactly one records.batch.');
  assert((await records('gd.note')).find(n => n.recordId === 'gd.note.start-here').values[F.body].includes('- [x] Link it to this one'), 'A tick in the strip must be written into the body.');
  assert((await records('gd.task')).find(t => t.values[F.taskTitle] === 'Link it to this one')?.values[F.taskDone] === true, 'The task ticked in the strip must be done.');
  const allDone = await strip();
  assert(allDone.count === '2 of 2 tasks done' && allDone.finished && allDone.next === null && await frame.locator('#reading-body input[data-line]:not(:checked)').count() === 0,
    `With every task done the strip must say so, and the text's boxes be ticked: ${JSON.stringify(allDone)}.`);
  // A task added by hand, a day late, is listed after the body's; Show all lists every task, and its
  // box, pressed from the keyboard, writes the task's record and keeps the focus. Undo takes it back.
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); const pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })();
  await page.evaluate(due => {
    window.broker.put('gd.task', { recordId: 'gd.task.call-the-nursery', version: 1, values: { 'gd.task.title': 'Call the nursery about `seeds`', 'gd.task.note': 'gd.note.start-here', 'gd.task.done': false, 'gd.task.source': 'Manual', 'gd.task.key': null, 'gd.task.due': due } });
    window.broker.pushChanges();
  }, yesterday);
  await frame.waitForFunction(() => window.garden.taskStrip.total === 3, null, { timeout: 3000 }).catch(async () => { throw Error(`A task added by hand must join the strip: ${JSON.stringify(await strip())}.`); });
  const added = await strip();
  assert(added.count === '2 of 3 tasks done' && added.next === 'Call the nursery about seeds', `The task added by hand is the next one to do: ${JSON.stringify(added)}.`);
  const showAll = await frame.locator('#task-all').boundingBox();
  await page.mouse.click(showAll.x + showAll.width / 2, showAll.y + showAll.height / 2);
  const listed = await frame.evaluate(() => ({ rows: [...document.querySelectorAll('#task-list .strip-task')].map(row => [row.querySelector('.text').textContent, row.classList.contains('done'), row.querySelector('.due')?.className ?? null, !!row.querySelector('.open-task')]),
    expanded: document.getElementById('task-all').getAttribute('aria-expanded'), label: document.querySelector('#task-all .label').textContent,
    kept: Object.entries(localStorage).find(([key]) => key.startsWith('garden.tasks.all'))?.[1] ?? null }));
  assert(JSON.stringify(listed.rows) === JSON.stringify([['Plant your first note with New note', true, null, true], ['Link it to this one', true, null, true], ['Call the nursery about seeds', false, 'due late', true]])
    && listed.expanded === 'true' && listed.label === 'Show less' && listed.kept === 'open', `Show all must list every task in order, with the late due date and a way to each record, and be kept: ${JSON.stringify(listed)}.`);
  const manualBefore0 = await requests('records.batch');
  await frame.locator('#task-list .strip-task[data-id="record:gd.task.call-the-nursery"] .box').focus();
  await page.keyboard.press('Space');
  await frame.waitForFunction(() => window.garden.taskStrip.done === 3, null, { timeout: 3000 }).catch(async () => { throw Error(`The box of a task added by hand must tick its record: ${JSON.stringify(await strip())}.`); });
  assert(await requests('records.batch') === manualBefore0 + 1 && (await records('gd.task')).find(t => t.recordId === 'gd.task.call-the-nursery').values[F.taskDone] === true,
    'A task added by hand is ticked by one records.batch that writes its record.');
  assert(await frame.evaluate(() => document.activeElement?.dataset.id) === 'record:gd.task.call-the-nursery', 'The box ticked from the keyboard keeps the focus.');
  await command('undo');
  await frame.waitForFunction(() => window.garden.taskStrip.done === 2, null, { timeout: 3000 }).catch(() => { throw Error('Undo must take the tick of a task added by hand back.'); });
  assert((await records('gd.task')).find(t => t.recordId === 'gd.task.call-the-nursery').values[F.taskDone] === false, 'Undo puts the task added by hand back to open.');
  await command('undo');
  await frame.waitForFunction(() => window.garden.taskStrip.done === 1 && window.garden.undo.length === 1, null, { timeout: 3000 }).catch(() => { throw Error('Undo must take the strip\'s tick in the body back.'); });
  await frame.locator('#task-strip').screenshot({ path: '__OUTPUT__/task-strip.png' });
  await frame.locator('#task-all').click();
  assert((await strip()).expanded === 'false', 'Show less folds the list away again.');
  checks.push('task strip');

  // A wikilink followed while reading opens its note and declares a place.
  await frame.locator('#reading-body a.wikilink[data-id="gd.note.how-links-work"]').first().click();
  await frame.waitForFunction(() => window.garden.note?.recordId === 'gd.note.how-links-work');
  // The place is declared once the note is shown, a moment after it is chosen: wait for it, then assert.
  await page.waitForFunction(() => window.broker.places.some(p => p.place.noteId === 'gd.note.how-links-work'), null, { timeout: 3000 }).catch(() => {});
  const places = await page.evaluate(() => window.broker.places);
  assert(places.some(p => p.place.noteId === 'gd.note.how-links-work' && p.label === 'How links work' && !p.replace), 'Following a wikilink must declare a new place named after the note: ' + JSON.stringify(places));
  const noTasks = await strip();
  assert(!noTasks.shown && noTasks.card === 0 && await frame.evaluate(() => window.garden.taskStrip.total) === 0, `A note with no tasks shows no strip: ${JSON.stringify(noTasks)}.`);
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
  checks.push('tree folds');

  // Show, above the tree, folds it to a level (the owner, 2026-10-08: Expand all and Collapse all
  // belong by the tree, not in the Note menu). The seeds are two levels deep, so somebody else first
  // nests three of them four deep: Start here > Daily notes > Daily note template > Tags and tasks.
  const nest = moves => page.evaluate(moves => {
    for (const [id, parent] of moves) {
      const note = window.broker.record('gd.note', id);
      window.broker.put('gd.note', { ...note, version: note.version + 1, values: { ...note.values, 'gd.note.parent': parent } });
    }
    window.broker.pushChanges();
  }, moves);
  const nested = parent => frame.waitForFunction(parent => window.garden.index.find(n => n.recordId === 'gd.note.tags-and-tasks')?.values['gd.note.parent'] === parent, parent, { timeout: 3000 });
  await nest([['gd.note.daily-note-template', 'gd.note.daily-notes'], ['gd.note.tags-and-tasks', 'gd.note.daily-note-template']]);
  await nested('gd.note.daily-note-template');
  const head = await frame.evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const side = rect('sidebar'), top = rect('tree-head'), title = rect('tree-title'), shown = rect('levels'), tree = rect('tree');
    const buttons = [...document.querySelectorAll('#levels button')].map(b => ({ label: b.textContent, top: b.getBoundingClientRect().top, height: b.getBoundingClientRect().height }));
    return { labels: buttons.map(b => b.label).join(' '), inside: shown.left >= side.left && shown.right <= side.right - 4, oneRow: Math.abs((shown.top + shown.height / 2) - (title.top + title.height / 2)) < 2,
      treeBelow: tree.top >= top.bottom - 0.5, height: Math.round(Math.min(...buttons.map(b => b.height))) };
  });
  assert(head.labels === '1 2 3 All' && head.inside && head.oneRow && head.treeBelow && head.height >= 20,
    `Show must sit above the tree, beside Notes, inside the sidebar, its four buttons at least 20 px tall: ${JSON.stringify(head)}.`);
  const more = (await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(item => item.id === 'more');
  assert(more && !more.items.some(item => /expand|collapse/i.test(`${item.id} ${item.label}`)), 'Expand all and Collapse all must leave the Note menu: ' + JSON.stringify(more?.items.map(item => item.id)));
  const levelShown = () => frame.evaluate(() => ({ rows: document.querySelectorAll('#tree .row').length, pressed: [...document.querySelectorAll('#levels button[aria-pressed=true]')].map(b => b.dataset.level).join(), level: window.garden.level }));
  const pickLevel = async level => {
    const box = await frame.locator(`#levels button[data-level="${level}"]`).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const levelRows = { 1: 1, 2: 4, 3: 5, all: seedNotes };
  for (const [level, rows] of Object.entries(levelRows)) {
    await pickLevel(level);
    const shown = await levelShown();
    assert(shown.rows === rows && shown.pressed === level && shown.level === level, `Show ${level} must show ${rows} rows and be the one pressed: ${JSON.stringify(shown)}.`);
  }
  await frame.locator('#sidebar').screenshot({ path: '__OUTPUT__/tree-levels.png' });
  const startTwisty = await frame.locator('#tree .row[data-id="gd.note.start-here"] .twisty').boundingBox();
  await page.mouse.click(startTwisty.x + startTwisty.width / 2, startTwisty.y + startTwisty.height / 2);
  const byHand = await levelShown();
  assert(byHand.rows === 1 && byHand.pressed === '' && byHand.level === null, `A branch folded by hand must release the level pressed: ${JSON.stringify(byHand)}.`);
  // A command reaches the view as an event, a moment after it is sent: wait for it, then go on.
  const levelsDisabled = disabled => frame.waitForFunction(disabled => [...document.querySelectorAll('#levels button')].every(b => b.disabled === disabled), disabled, { timeout: 2000 });
  await command('find', 'template');
  await levelsDisabled(true).catch(() => { throw Error('Show must wait while Find unfolds what it found.'); });
  await command('find', '');
  await levelsDisabled(false).catch(() => { throw Error('Show must come back once Find is cleared.'); });
  await nest([['gd.note.daily-note-template', 'gd.note.start-here'], ['gd.note.tags-and-tasks', 'gd.note.start-here']]);
  await nested('gd.note.start-here');
  await pickLevel('all');
  assert((await levelShown()).rows === seedNotes, 'Show All must unfold every branch.');
  checks.push('tree levels');

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
        wikilink: getComputedStyle(document.querySelector('#preview a.wikilink')).color, cobalt: token('cobalt'),
        level: getComputedStyle(document.querySelector('#levels button[aria-pressed=true]')).backgroundColor, cobaltSoft: token('cobalt-soft'),
        strip: getComputedStyle(document.getElementById('task-strip')).backgroundColor, surfaceSoft: token('surface-soft'),
        box: getComputedStyle(document.querySelector('#reading-body li.task > input:checked')).backgroundColor };
    });
    assert(colours[mode].wikilink === colours[mode].cobalt, `${mode}: a wikilink must be the cobalt token: ${JSON.stringify(colours[mode])}`);
    assert(colours[mode].level === colours[mode].cobaltSoft, `${mode}: the level Show presses must be the cobalt-soft token: ${JSON.stringify(colours[mode])}`);
    assert(colours[mode].strip === colours[mode].surfaceSoft && colours[mode].box === colours[mode].cobalt, `${mode}: the task strip must be the surface-soft token and a ticked box the cobalt token: ${JSON.stringify(colours[mode])}`);
    await page.screenshot({ path: '__OUTPUT__/' + mode + '.png', fullPage: true });
  }
  assert(colours.light.background !== colours.dark.background && colours.light.ink !== colours.dark.ink && colours.light.level !== colours.dark.level && colours.light.strip !== colours.dark.strip, 'The theme must change the frame: ' + JSON.stringify(colours));
  checks.push('Light/Dark');

  // 10a. A ```mermaid fence is drawn as a diagram in the preview and the page, in the theme's
  // tokens; one that does not parse keeps its source and says why. Mermaid loads only now.
  assert(await frame.evaluate(() => !window.mermaid && !document.querySelector('script[src*="mermaid"]')), 'Mermaid must not load before a note has a diagram.');
  const bodyBefore = await frame.evaluate(() => document.getElementById('editor').value);
  const diagramBody = `${bodyBefore}\n\n\`\`\`mermaid\nflowchart LR\n  A[Seed] --> B[Growing]\n  B --> C[Evergreen]\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  A -->\n\`\`\`\n`;
  await frame.evaluate(body => { const e = document.getElementById('editor'); e.value = body; e.dispatchEvent(new Event('input', { bubbles: true })); }, diagramBody);
  const diagramState = () => frame.evaluate(() => [...document.querySelectorAll('#preview figure.diagram, #reading-body figure.diagram')].map(f => `${f.parentElement.id}:${f.dataset.state ?? 'waiting'}`));
  await frame.waitForFunction(() => ['#preview', '#reading-body'].every(root => document.querySelector(`${root} figure.diagram[data-state=drawn] svg`) && document.querySelector(`${root} figure.diagram[data-state=error]`)), { timeout: 20000 })
    .catch(async () => { throw Error(`A mermaid fence must be drawn in the preview and the page, and a broken one marked: ${JSON.stringify(await diagramState())}.`); });
  const diagramColours = {};
  for (const mode of ['light', 'dark']) {
    const before = await frame.evaluate(() => document.querySelector('#preview figure.diagram[data-state=drawn]').dataset.theme);
    await page.evaluate(mode => window.broker.pushTheme(mode), mode);
    await frame.waitForFunction(before => { const f = document.querySelector('#preview figure.diagram[data-state=drawn]'); return f && f.dataset.theme !== before; }, before, { timeout: 15000 }).catch(() => {});
    diagramColours[mode] = await frame.evaluate(() => {
      const token = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      const figure = document.querySelector('#preview figure.diagram[data-state=drawn]'), svg = figure.querySelector('svg'), box = svg.getBoundingClientRect();
      const shape = svg.querySelector('g.node rect, g.node path, g.node polygon'), label = svg.querySelector('g.node .nodeLabel, g.node text');
      const broken = document.querySelector('#preview figure.diagram[data-state=error]');
      return { nodes: svg.querySelectorAll('g.node').length, text: [...svg.querySelectorAll('g.node')].map(node => node.textContent.trim()).join('|'), width: box.width, height: box.height,
        sourceHidden: getComputedStyle(figure.querySelector('pre')).display === 'none',
        fill: getComputedStyle(shape).fill, stroke: getComputedStyle(shape).stroke, ink: getComputedStyle(label).color,
        soft: token('cobalt-soft'), cobalt: token('cobalt'), inkToken: token('ink'),
        // A copy of the drawing elsewhere on the page must not share its IDs, or its arrows point at hidden markers.
        sharedIds: [...document.querySelectorAll('figure.diagram svg [id], figure.diagram svg[id]')].map(e => e.id).filter(id => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length > 1).slice(0, 3),
        arrows: [...svg.querySelectorAll('[marker-end]')].filter(path => { const m = /url\(#([^)]+)\)/.exec(path.getAttribute('marker-end')); return m && svg.contains(document.getElementById(m[1])); }).length,
        error: broken.querySelector('figcaption')?.textContent ?? '', brokenSource: broken.querySelector('pre').getClientRects().length > 0 ? broken.querySelector('pre').textContent : '' };
    });
    await page.screenshot({ path: '__OUTPUT__/diagram-' + mode + '.png' });
    const d = diagramColours[mode];
    assert(d.nodes === 3 && ['Seed', 'Growing', 'Evergreen'].every(word => d.text.includes(word)) && d.width > 120 && d.height > 20 && d.sourceHidden,
      `${mode}: the diagram must draw its three nodes in place of its source: ${JSON.stringify(d)}.`);
    assert(d.sharedIds.length === 0 && d.arrows === 2, `${mode}: each copy of a diagram must own its IDs, so its two arrows find their heads: ${JSON.stringify({ sharedIds: d.sharedIds, arrows: d.arrows })}.`);
    assert(d.fill === d.soft && d.stroke === d.cobalt && d.ink === d.inkToken, `${mode}: the diagram must be drawn in the theme's tokens: ${JSON.stringify(d)}.`);
    assert(d.error.startsWith('This diagram could not be drawn') && d.brokenSource.includes('A -->'), `${mode}: a diagram that does not parse must keep its source and say why: ${JSON.stringify(d)}.`);
  }
  assert(diagramColours.light.fill !== diagramColours.dark.fill, 'A theme change must redraw the diagram in the new colours.');
  assert(await frame.evaluate(() => document.querySelectorAll('script[src*="mermaid"]').length === 1), 'Mermaid must load once.');
  await frame.evaluate(body => { const e = document.getElementById('editor'); e.value = body; e.dispatchEvent(new Event('input', { bubbles: true })); }, bodyBefore);
  checks.push('mermaid diagrams');

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
  assert(await frame.evaluate(() => window.gardenGraph.options.colour) === 'branch', 'A garden with a tree must open its graph coloured by branch.');
  // The Graph screen too is seen almost where it settles, framed there, and still within two seconds.
  const placed = () => frame.evaluate(() => Object.fromEntries([...document.querySelectorAll('#graph-canvas .node')].map(node => { const b = node.getBoundingClientRect(); return [node.dataset.id, [b.x, b.y]]; })));
  const shown = await placed(); await page.waitForTimeout(2000); const rested = await placed(); await page.waitForTimeout(300); const resting = await placed();
  const moved = (a, b) => Math.round(Math.max(...Object.keys(a).map(id => Math.hypot(a[id][0] - b[id][0], a[id][1] - b[id][1]))));
  settle.screen = { travelled: moved(shown, rested), afterTwoSeconds: moved(rested, resting) };
  assert(settle.screen.travelled <= 80 && settle.screen.afterTwoSeconds <= 2, `The Graph screen must be seen near where it settles and be still within two seconds: ${JSON.stringify(settle.screen)}.`);
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
  await command('colour', 'stage');
  await page.waitForTimeout(150);
  const stageLegend = await frame.evaluate(() => [...document.querySelectorAll('#graph-legend .chip')].map(chip => chip.textContent));
  assert(JSON.stringify(stageLegend) === JSON.stringify(['Growing', 'Evergreen']), `The legend must name the stages the graph shows, in their order: ${JSON.stringify(stageLegend)}.`);
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
  // Colour by Branch: each note in its section's tone, the top-level note grey.
  await command('colour', 'branch');
  await page.waitForTimeout(150);
  const byBranch = await frame.evaluate(() => {
    const token = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
    const fill = id => getComputedStyle(document.querySelector(`#graph-canvas .node[data-id="${id}"] circle`)).fill;
    return { first: fill('gd.note.how-links-work'), blue: token('tone-blue'), second: fill('gd.note.daily-notes'), teal: token('tone-teal'), root: fill('gd.note.start-here'), grey: token('tone-grey') };
  });
  assert(byBranch.first === byBranch.blue && byBranch.second === byBranch.teal && byBranch.root === byBranch.grey, `Colour by Branch must draw each note in its branch's tone: ${JSON.stringify(byBranch)}`);
  const branchLegend = await frame.evaluate(() => [...document.querySelectorAll('#graph-legend .chip')].map(chip => chip.textContent));
  assert(JSON.stringify(branchLegend) === JSON.stringify(['How links work', 'Daily notes', 'Tags and tasks', 'For agents', 'Daily note template']), `The legend must name the branches in tree order: ${JSON.stringify(branchLegend)}.`);

  // Highlight by tag (the owner, 2026-10-07): the tags beside the graph, most carried first; a click
  // picks out the notes that carry a tag and fades the rest, the camera staying where it is; two tags
  // ask for all of them unless the person says any, and the counts beside the other tags say what is
  // left; a colour in the legend narrows it further; a tag dot picks its tag; Esc clears it.
  await page.mouse.move(2, 2); await page.waitForTimeout(200);
  const tagRows = () => frame.evaluate(() => [...document.querySelectorAll('#graph-tags-list button')].map(b => [b.firstChild.textContent, b.querySelector('.count').textContent, b.getAttribute('aria-pressed') === 'true', b.classList.contains('empty')]));
  const picked = () => frame.evaluate(() => ({ notes: [...document.querySelectorAll('#graph-canvas .node.match')].map(n => n.dataset.id).filter(id => id.startsWith('gd.note.')).sort(),
    result: document.getElementById('graph-tags-result').textContent, summary: document.getElementById('graph-summary').textContent,
    searching: document.querySelector('#graph-canvas svg').classList.contains('searching'), k: window.gardenGraph.state().k,
    matchedEdges: document.querySelectorAll('#graph-canvas line.edge.match').length }));
  assert(await frame.locator('#graph-tags').isVisible(), 'A wide window shows the tags beside the graph.');
  const firstRows = await tagRows();
  assert(JSON.stringify(firstRows.map(r => [r[0], r[1]])) === JSON.stringify([['#garden', '5'], ['#howto', '4'], ['#agents', '1'], ['#tasks', '1']]),
    `The tags are listed by how many notes carry each, then by name: ${JSON.stringify(firstRows)}.`);
  const beforePick = await picked();
  await frame.locator('#graph-tags-list button[data-tag="gd.tag.howto"]').click();
  const howto = await picked();
  const howtoNotes = ['gd.note.daily-notes', 'gd.note.how-links-work', 'gd.note.start-here', 'gd.note.tags-and-tasks'];
  assert(howto.searching && JSON.stringify(howto.notes) === JSON.stringify(howtoNotes) && howto.result === '4 notes highlighted.' && howto.summary.includes('4 highlighted') && howto.matchedEdges > 0 && howto.k === beforePick.k,
    `A tag must pick out the notes that carry it, keep the links among them, say how many, and leave the camera where it was: ${JSON.stringify(howto)}.`);
  await page.waitForTimeout(250);
  const faded = await frame.evaluate(() => Number(getComputedStyle(document.querySelector('#graph-canvas .node[data-id="gd.note.for-agents"]')).opacity));
  assert(faded < 0.5, `A note without the tag fades: ${faded}.`);
  await page.screenshot({ path: '__OUTPUT__/graph-tag-picked.png', fullPage: true });
  const narrowed = Object.fromEntries((await tagRows()).map(r => [r[0], r]));
  assert(narrowed['#garden'][1] === '4' && narrowed['#tasks'][1] === '1' && narrowed['#agents'][1] === '0' && narrowed['#agents'][3] === true && narrowed['#howto'][2] === true,
    `With a tag chosen, the others count the highlighted notes that carry them, and one that would leave nothing says so: ${JSON.stringify(narrowed)}.`);
  await frame.locator('#graph-tags-list button[data-tag="gd.tag.agents"]').click();
  const none = await picked();
  assert(none.notes.length === 0 && none.result === 'No note carries all of these. Try Any of them.' && await frame.locator('#graph-tags-match').isVisible(),
    `Two tags no note carries together must say so, and offer Any: ${JSON.stringify(none)}.`);
  await frame.locator('#graph-tags-match button[data-match="any"]').click();
  const either = await picked();
  assert(either.notes.length === 5 && either.result === '5 notes highlighted.', `Any must pick out the notes that carry either tag: ${JSON.stringify(either)}.`);
  await frame.locator('#graph-legend button[data-value="gd.note.for-agents"]').click();
  const both = await picked();
  assert(JSON.stringify(both.notes) === JSON.stringify(['gd.note.for-agents']) && await frame.locator('#graph-legend button[data-value="gd.note.for-agents"]').getAttribute('aria-pressed') === 'true',
    `A colour in the legend narrows the highlight to the notes that are both: ${JSON.stringify(both)}.`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const tagCleared = await picked();
  assert(!tagCleared.searching && tagCleared.notes.length === 0 && (await tagRows()).every(r => !r[2]) && tagCleared.result === 'Click a tag to highlight the notes that carry it.',
    `Esc must clear the highlight: ${JSON.stringify(tagCleared)}.`);
  const openedBeforeTag = (await page.evaluate(() => window.broker.opened())).length;
  const dotAt = await centre('gd.tag.agents');
  await page.mouse.click(dotAt.x, dotAt.y);
  await page.waitForTimeout(150);
  const byDot = await picked();
  assert(JSON.stringify(byDot.notes) === JSON.stringify(['gd.note.for-agents']) && (await page.evaluate(() => window.broker.opened())).length === openedBeforeTag
    && (await tagRows()).find(r => r[0] === '#agents')[2] === true, `A click on a tag dot must pick its tag, and open nothing: ${JSON.stringify(byDot)}.`);
  await frame.locator('#graph-tags-clear').click();
  await frame.locator('#graph-tags-hide').click();
  assert(await frame.locator('#graph-tags').isHidden() && await frame.locator('#graph-tags-show').isVisible() && await frame.evaluate(() => localStorage.getItem('garden.graphTags')) === 'closed',
    'Hiding the tags must leave a button to show them, and be kept in this browser.');
  await frame.locator('#graph-tags-show').click();
  assert(await frame.locator('#graph-tags').isVisible(), 'The tags come back.');
  await page.mouse.move(2, 2);
  await page.screenshot({ path: '__OUTPUT__/graph-tags.png', fullPage: true });
  checks.push('highlight by tag');

  // A dense garden (the owner, 2026-10-07: a hundred notes were big dots under a mesh of names and
  // lines): the layout takes the window's shape, dots stay small, only the landmarks are named until
  // the person zooms in, and the links are drawn light.
  const baseNote = fixture.records['gd.note'].find(r => r.recordId === 'gd.note.how-links-work');
  const baseLink = fixture.records['gd.link'].find(r => r.values[F.source] === 'Body');
  const sections = ['how-links-work', 'daily-notes', 'tags-and-tasks', 'for-agents'].map(slug => `gd.note.${slug}`);
  const bigNotes = Array.from({ length: 96 }, (_, i) => ({ ...baseNote, recordId: `gd.note.dense-${i}`,
    values: { ...baseNote.values, 'gd.note.title': `Dense note ${i}`, [F.slug]: `dense-${i}`, 'gd.note.parent': sections[i % 4], 'gd.note.order': i } }));
  const bigLinks = bigNotes.flatMap((n, i) => [1, 2, 5, 11, 23].map(step => ({ ...baseLink, recordId: `gd.link.dense-${i}-${step}`,
    values: { ...baseLink.values, [F.from]: n.recordId, [F.to]: `gd.note.dense-${(i + step) % 96}` } })).concat({ ...baseLink, recordId: `gd.link.dense-${i}-up`,
    values: { ...baseLink.values, [F.from]: n.recordId, [F.to]: sections[i % 4] } }));
  const dense = { ...fixture, records: { ...fixture.records, 'gd.note': [...fixture.records['gd.note'], ...bigNotes], 'gd.link': [...fixture.records['gd.link'], ...bigLinks] }, context: graphContext };
  await page.evaluate(dense => { window.broker.setFixture(dense); window.broker.remount(); }, dense);
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.gardenGraph?.ready === true, { timeout: 15000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(2500);
  const crowd = await frame.evaluate(() => {
    const canvas = document.getElementById('graph-canvas').getBoundingClientRect();
    const circles = [...document.querySelectorAll('#graph-canvas .node circle')].map(c => c.getBoundingClientRect());
    const left = Math.min(...circles.map(b => b.left)), right = Math.max(...circles.map(b => b.right)), top = Math.min(...circles.map(b => b.top)), bottom = Math.max(...circles.map(b => b.bottom));
    const named = [...document.querySelectorAll('#graph-canvas .node .label')].filter(label => Number(getComputedStyle(label).opacity) > 0.5).length;
    return { notes: circles.length, k: +window.gardenGraph.state().k.toFixed(2), named, dot: Math.round(Math.max(...circles.map(b => b.width))),
      shape: +((right - left) / (bottom - top)).toFixed(2), off: +(Math.max(Math.abs((left + right) / 2 - (canvas.left + canvas.right) / 2) / canvas.width, Math.abs((top + bottom) / 2 - (canvas.top + canvas.bottom) / 2) / canvas.height)).toFixed(3),
      inside: left >= canvas.left - 1 && right <= canvas.right + 1 && top >= canvas.top - 1 && bottom <= canvas.bottom + 1,
      dense: document.querySelector('#graph-canvas svg').classList.contains('dense') };
  });
  assert(crowd.notes === 102 && crowd.dense && crowd.inside && crowd.off <= 0.05 && crowd.shape >= 1.3 && crowd.dot <= 30 && (crowd.named <= 12 || crowd.k >= 1.6),
    `A dense garden must be drawn centred, inside the screen, wider than tall in a wide window, with dots at most 30 px, light links and names only on its landmarks: ${JSON.stringify(crowd)}.`);
  settle.dense = crowd;
  await page.screenshot({ path: '__OUTPUT__/graph-dense.png', fullPage: true });
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

  // The Garden guide: Nendo's row toggles it; it opens beside the page with focus on it. Its drawing
  // is the chart of this garden: each stage's count stands under its plant, and a stage with no notes
  // is drawn as an outline. The other numbers are one ruled row, the topics open one at a time under a
  // real pointer, it is drawn in the theme's tokens, closes on Esc, and New note acts.
  await command('about', true);
  await frame.waitForFunction(() => !document.getElementById('guide').hidden, null, { timeout: 2000 }).catch(() => { throw Error('Garden guide must open from Nendo\'s row.'); });
  await page.waitForFunction(() => window.broker.toolbars.at(-1).items.find(i => i.id === 'about')?.pressed === true, null, { timeout: 2000 })
    .catch(async () => { throw Error('Nendo\'s row must show the guide as open: ' + JSON.stringify((await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(i => i.id === 'about'))); });
  // The plants sprout and the counts rise in over about 1.5 s, which a busy or hidden browser runs
  // late: wait for the guide's animations to finish rather than for a fixed time.
  await frame.waitForFunction(() => document.getElementById('guide').getAnimations({ subtree: true }).every(a => a.playState === 'finished'), null, { timeout: 4000 }).catch(() => {});
  const guideOpen = await frame.evaluate(() => {
    const guide = document.getElementById('guide'), box = guide.getBoundingClientRect(), art = document.querySelector('.guide-art').getBoundingClientRect();
    const stat = name => Number(document.querySelector(`[data-stat=${name}]`).textContent.replace(/\D/g, ''));
    const centre = e => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; };
    const stages = ['Seed', 'Growing', 'Evergreen'].map(stage => {
      const plant = document.querySelector(`.guide-art .plant[data-stage=${stage}]`), count = document.querySelector(`.guide-stages [data-stage=${stage}]`);
      if (!plant || !count?.querySelector('dd')) return { stage, plant: !!plant, count: count?.textContent ?? null };
      return { stage, count: Number(count.querySelector('dd').textContent.replace(/\D/g, '')), offset: Math.round(Math.abs(centre(plant) - centre(count))),
        below: count.getBoundingClientRect().top >= art.bottom - 1, outline: plant.classList.contains('is-empty'),
        fill: getComputedStyle(plant.querySelector('circle')).fill, opacity: Number(getComputedStyle(count).opacity) };
    });
    const tops = [...document.querySelectorAll('.guide-stats > div')].map(d => Math.round(d.getBoundingClientRect().top));
    // Each first move's words hang beside its number: where the text starts, and how many lines it takes.
    const steps = [...document.querySelectorAll('#guide-start .guide-steps li')].map(li => {
      const box = li.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(li);
      const left = Math.min(...[...range.getClientRects()].filter(r => r.width > 0).map(r => r.left));
      return { indent: Math.round(left - box.left), lines: Math.round(box.height / parseFloat(getComputedStyle(li).lineHeight)) };
    });
    return { notes: stat('notes'), links: stat('links'), tags: stat('tags'), stages, steps, statRow: tops.length === 4 && new Set(tops).size === 1,
      old: document.querySelectorAll('#guide .stage-bar, #guide .guide-toc, #guide .guide-kicker').length,
      topics: document.querySelectorAll('#guide details.guide-topic').length, open: [...document.querySelectorAll('#guide details.guide-topic[open]')].map(d => d.id),
      focus: document.activeElement?.id, right: innerWidth - box.right, width: box.width,
      picks: document.querySelectorAll('#guide-picks li').length, note: window.garden.note?.recordId };
  });
  const noteRows = await records('gd.note'), notesNow = noteRows.length, linksNow = (await records('gd.link')).length, tagsNow = (await records('gd.tag')).length;
  const growing = noteRows.filter(note => note.values['gd.note.kind'] !== 'Template');
  const byStage = ['Seed', 'Growing', 'Evergreen'].map(stage => growing.filter(note => (note.values[F.stage] ?? 'Seed') === stage).length);
  assert(guideOpen.notes === notesNow && guideOpen.links === linksNow && guideOpen.tags === tagsNow && guideOpen.focus === 'guide' && Math.abs(guideOpen.right) <= 1
    && guideOpen.width >= 400 && guideOpen.picks >= 1 && guideOpen.note === 'gd.note.start-here',
    `The guide must open beside the page and count this garden (${notesNow} notes, ${linksNow} links, ${tagsNow} tags): ${JSON.stringify(guideOpen)}.`);
  assert(guideOpen.stages.every((s, i) => s.count === byStage[i] && s.offset <= 2 && s.below && s.opacity === 1 && s.outline === (s.count === 0) && (s.fill === 'none') === s.outline),
    `Each stage's count (${byStage.join(', ')}) must stand under its plant, and a stage with none be drawn as an outline: ${JSON.stringify(guideOpen.stages)}.`);
  assert(guideOpen.statRow && guideOpen.old === 0 && guideOpen.topics === 6 && JSON.stringify(guideOpen.open) === '["guide-start"]',
    `Notes, links, tags and unlinked notes are one row, and the guide's topics open in place with Start open: ${JSON.stringify(guideOpen)}.`);
  assert(guideOpen.steps.length === 4 && guideOpen.steps.every(s => s.indent >= 16 && s.lines <= 4),
    `Each first move must read as a paragraph beside its number, not a word per line: ${JSON.stringify(guideOpen.steps)}.`);
  // Keys, near the end, opens under a real pointer, and Start closes: one topic at a time.
  await frame.locator('#guide-keys > summary').scrollIntoViewIfNeeded();
  const keysTopic = await frame.locator('#guide-keys > summary').boundingBox();
  await page.mouse.click(keysTopic.x + keysTopic.width / 2, keysTopic.y + keysTopic.height / 2);
  await frame.waitForFunction(() => document.getElementById('guide-keys').open, null, { timeout: 2000 }).catch(() => {});
  const topicOpen = await frame.evaluate(() => ({ open: [...document.querySelectorAll('#guide details.guide-topic[open]')].map(d => d.id),
    keys: Math.round(document.querySelector('#guide-keys .guide-keys').getBoundingClientRect().height) }));
  assert(JSON.stringify(topicOpen.open) === '["guide-keys"]' && topicOpen.keys >= 100, `Keys must open in place and close Start: ${JSON.stringify(topicOpen)}.`);
  // The pictures show Start open, where the first moves are.
  await frame.evaluate(() => { document.getElementById('guide-start').open = true; });
  const guideColours = {};
  for (const mode of ['dark', 'light']) {
    await page.evaluate(mode => window.broker.pushTheme(mode), mode); await page.waitForTimeout(150);
    guideColours[mode] = await frame.evaluate(() => {
      const token = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
      const guide = document.getElementById('guide'), crown = getComputedStyle(document.querySelector('.guide-art .evergreen .crown'));
      return { background: getComputedStyle(guide).backgroundColor, raised: token('surface-raised'), ink: getComputedStyle(guide).color,
        evergreen: crown.fill === 'none' ? crown.stroke : crown.fill, green: token('tone-green') };
    });
    assert(guideColours[mode].background === guideColours[mode].raised && guideColours[mode].evergreen === guideColours[mode].green, `${mode}: the guide is drawn in the theme's tokens: ${JSON.stringify(guideColours[mode])}`);
    await frame.locator('.guide-body').evaluate(body => { body.scrollTop = 0; });
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
    .catch(async () => { throw Error('New note must close the guide and open a new note in Edit: ' + JSON.stringify(await frame.evaluate(() => ({ hidden: document.getElementById('guide').hidden, mode: window.garden.mode, note: window.garden.note?.recordId ?? null })))); });
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

  // 20. The Overview (W-179): the garden's front page is led by its graph, not by lists of text. The
  // graph is the largest thing on the page and draws every note; the stages pick notes out on it;
  // the notes are cards with their first line; a note picked there opens in the Garden view.
  await page.setViewportSize({ width: 1440, height: 900 });
  const homeContext = { ...fixture.context, viewId: 'gd.home', title: 'Overview' };
  await page.evaluate(({ fixture, homeContext }) => { window.broker.offerScreens(true); window.broker.setFixture({ ...fixture, context: homeContext }); window.broker.pushTheme('light'); window.broker.remount(); }, { fixture, homeContext });
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.gardenHome?.ready === true, { timeout: 15000 })
    .catch(async () => { throw Error(`The Overview must start on gd.home: ${JSON.stringify(await frame.evaluate(() => ({ home: !!window.gardenHome, garden: !!window.garden, shown: !document.getElementById('home')?.hidden })))}.`); });
  await page.waitForTimeout(1600);
  const homePairs = new Set(fixture.records['gd.link'].filter(l => l.values[F.from] !== l.values[F.to]).map(l => `${l.values[F.from]}>${l.values[F.to]}`));
  const hero = await frame.evaluate(() => {
    const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, area: r.width * r.height }; };
    const graph = box('home-graph'), page = box('home');
    const others = ['home-side', 'home-pinned-section'].map(id => [id, box(id)]);
    const circles = [...document.querySelectorAll('#home-graph .node circle')].map(c => c.getBoundingClientRect());
    const inside = circles.every(c => c.x >= graph.x - 1 && c.right <= graph.x + graph.w + 1 && c.y >= graph.y - 1 && c.bottom <= graph.y + graph.h + 1);
    return { graph, page, larger: others.filter(([, b]) => b.area >= graph.area).map(([id]) => id), nodes: circles.length, edges: document.querySelectorAll('#home-graph line.edge').length, inside,
      notes: document.getElementById('home-notes').textContent, links: document.getElementById('home-links').textContent,
      lists: document.querySelectorAll('#home table, #home .recent-list').length, top: graph.y < 120 };
  });
  assert(hero.nodes === seedNotes && hero.edges === homePairs.size && hero.inside, `The Overview's graph must draw every note (${seedNotes}) and linked pair (${homePairs.size}) inside its box: ${JSON.stringify(hero)}.`);
  assert(hero.larger.length === 0 && hero.top && hero.graph.w >= hero.page.w * 0.55 && hero.graph.h >= 380,
    `The graph must lead the Overview: at the top, the largest thing on it, at least 55% of its width and 380 px tall: ${JSON.stringify(hero)}.`);
  assert(hero.notes === String(seedNotes) && hero.links === String(homePairs.size), `Beside the graph, the notes and links it draws: ${JSON.stringify(hero)}.`);
  assert(hero.lists === 0, 'The Overview holds no table or list of records.');
  // The dots take their stage's colour, as the buttons beside them that pick a stage out do.
  const dotTones = await frame.evaluate(stages => {
    const tone = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-tone-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
    const want = { Seed: tone('amber'), Growing: tone('teal'), Evergreen: tone('green') };
    return [...document.querySelectorAll('#home-graph .node')].filter(n => getComputedStyle(n.querySelector('circle')).fill !== want[stages[n.dataset.id]]).map(n => [n.dataset.id, stages[n.dataset.id], getComputedStyle(n.querySelector('circle')).fill]);
  }, Object.fromEntries(fixture.records['gd.note'].map(n => [n.recordId, n.values[F.stage]])));
  assert(dotTones.length === 0, `Every dot on the Overview's graph must be its stage's colour: ${JSON.stringify(dotTones)}.`);
  // A stage picks its notes out on the graph, with a real pointer; Esc lets them go.
  const evergreen = fixture.records['gd.note'].filter(n => n.values[F.stage] === 'Evergreen').map(n => n.recordId).sort();
  const stageButtons = await frame.evaluate(() => [...document.querySelectorAll('#home-stages button')].map(b => [b.dataset.stage, b.querySelector('b').textContent]));
  assert(JSON.stringify(stageButtons) === JSON.stringify([['Seed', '0'], ['Growing', String(seedNotes - evergreen.length)], ['Evergreen', String(evergreen.length)]]), `The stages and their counts, in order: ${JSON.stringify(stageButtons)}.`);
  await frame.locator('#home-stages button[data-stage="Evergreen"]').click();
  const stagePicked = await frame.evaluate(() => ({ searching: document.querySelector('#home-graph svg').classList.contains('searching'), match: [...document.querySelectorAll('#home-graph .node.match')].map(n => n.dataset.id).sort(),
    pressed: document.querySelector('#home-stages button[data-stage="Evergreen"]').getAttribute('aria-pressed') }));
  assert(stagePicked.searching && stagePicked.pressed === 'true' && JSON.stringify(stagePicked.match) === JSON.stringify(evergreen), `Evergreen must pick out its ${evergreen.length} notes on the graph: ${JSON.stringify(stagePicked)}.`);
  await page.keyboard.press('Escape');
  assert(await frame.evaluate(() => document.querySelectorAll('#home-graph .node.match').length === 0 && !document.querySelector('#home-graph svg').classList.contains('searching')), 'Esc must let the picked notes go.');
  // The notes are cards: a title and the first line of what they say, never a bare row of names.
  const cards = await frame.evaluate(() => [...document.querySelectorAll('#home .home-card')].map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.id, title: c.querySelector('.home-card-title').textContent, text: c.querySelector('.home-card-text').textContent, w: r.width, h: r.height }; }));
  const pinnedSeeds = fixture.records['gd.note'].filter(n => n.values['gd.note.pinned']).length;
  assert(cards.length === pinnedSeeds && cards.every(c => c.title && c.text && c.text !== 'Nothing written yet.' && c.w >= 200 && c.h >= 90), `The pinned notes, and only they, must be cards with their first line: ${JSON.stringify(cards)}.`);
  // The owner, 2026-10-07: no Tended lately and no Due next, and the tags sit in the hero's side,
  // under the stages and over the buttons, where the side had room; the graph keeps the side's height.
  const side = await frame.evaluate(() => {
    const box = selector => { const e = document.querySelector(selector); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height }; };
    return { stages: box('#home-stages'), tags: box('#home-tags-card'), actions: box('.home-actions'), side: box('#home-side'), graph: box('#home-graph'),
      inSide: !!document.querySelector('#home-side #home-tags'), tagButtons: document.querySelectorAll('#home-tags button').length,
      gone: ['#home-lately', '#home-tasks', '#home-lately-section', '#home-tasks-card'].filter(s => document.querySelector(s)),
      headings: [...document.querySelectorAll('#home h2')].map(h => h.textContent.trim()) };
  });
  assert(side.gone.length === 0 && !side.headings.some(h => /Tended lately|Due next/.test(h)), `The Overview has no Tended lately and no Due next: ${JSON.stringify(side)}.`);
  assert(side.inSide && side.tags && side.tagButtons > 0 && side.tags.top >= side.stages.bottom && side.tags.bottom <= side.actions.top && side.tags.left >= side.side.left && side.tags.right <= side.side.right,
    `The tags must sit in the hero's side, under the stages and over the buttons: ${JSON.stringify(side)}.`);
  assert(Math.abs(side.graph.h - side.side.h) <= 1, `The graph must keep the side's height: ${JSON.stringify(side)}.`);
  const firstTag = fixture.records['gd.tag'].find(tag => fixture.records['gd.noteTag'].some(row => row.values[F.noteTagTag] === tag.recordId));
  const carriersOf = [...new Set(fixture.records['gd.noteTag'].filter(row => row.values[F.noteTagTag] === firstTag.recordId).map(row => row.values[F.noteTagNote]))].sort();
  await frame.locator(`#home-tags button[data-tag="${firstTag.recordId}"]`).click();
  const tagPicked = await frame.evaluate(() => [...document.querySelectorAll('#home-graph .node.match')].map(n => n.dataset.id).sort());
  assert(JSON.stringify(tagPicked) === JSON.stringify(carriersOf), `A tag must pick out the notes that carry it: ${JSON.stringify({ tagPicked, carriersOf })}.`);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: '__OUTPUT__/overview.png', fullPage: true });
  // Find: titles light up and are listed; Enter on words no note is titled offers a new one.
  await frame.locator('#home-find').click();
  await page.keyboard.type('links');
  await frame.waitForFunction(() => !document.getElementById('home-found').hidden);
  const foundLinks = await frame.evaluate(() => ({ options: [...document.querySelectorAll('#home-found li')].map(li => li.textContent), match: document.querySelectorAll('#home-graph .node.match').length }));
  assert(foundLinks.options[0]?.includes('How links work') && foundLinks.match >= 1 && foundLinks.options.at(-1).startsWith('New note'), `Find must list How links work first, light it on the graph and offer a new note: ${JSON.stringify(foundLinks)}.`);
  await frame.locator('#home-find').fill('');
  await page.keyboard.type('How links work');
  await frame.waitForFunction(() => [...document.querySelectorAll('#home-found li')].length > 0);
  assert(!(await frame.evaluate(() => [...document.querySelectorAll('#home-found li')].some(li => li.textContent.startsWith('New note')))), 'A title a note already has offers no new note.');
  // A card opens its note in the Garden view: the Overview hands the note over and opens that screen,
  // and the Garden view, started on it, opens the note rather than its pinned map.
  await frame.locator('#home-find').fill('');
  const target = cards.find(c => c.id !== 'gd.note.start-here');
  const recordPagesBefore = (await page.evaluate(() => window.broker.opened())).length;
  await frame.locator(`#home .home-card[data-id="${target.id}"]`).click();
  // The screen is opened through the host, an answer later than the click.
  await page.waitForFunction(() => window.broker.screensOpened().length > 0, null, { timeout: 2000 }).catch(() => undefined);
  const screens = await page.evaluate(() => window.broker.screensOpened());
  const handed = await frame.evaluate(() => JSON.parse(localStorage.getItem('garden.handover.v1') ?? 'null'));
  assert(screens.at(-1) === 'gd.garden' && handed?.open === target.id, `A card must hand ${target.id} to the Garden view and open it: ${JSON.stringify({ screens, handed })}.`);
  assert((await page.evaluate(() => window.broker.opened())).length === recordPagesBefore, 'A card opens the Garden view, not the note\'s record page.');
  await page.evaluate(fixture => { window.broker.setFixture(fixture); window.broker.remount(); }, fixture);
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.garden?.ready === true, { timeout: 15000 });
  await frame.waitForFunction(id => window.garden.note?.recordId === id, target.id, { timeout: 3000 })
    .catch(async () => { throw Error(`The Garden view must open ${target.id}, the note the Overview handed over: ${await frame.evaluate(() => window.garden.note?.recordId)}.`); });
  assert(await frame.evaluate(() => localStorage.getItem('garden.handover.v1') === null), 'The hand-over is taken once.');
  checks.push('overview led by the graph, its picks, tags in its side and pinned cards, and a note handed to the Garden view');
  // Dark uses the theme's tokens; at a narrow width the side stacks over the graph with no sideways scroll.
  await page.evaluate(({ fixture, homeContext }) => { window.broker.setFixture({ ...fixture, context: homeContext }); window.broker.remount(); }, { fixture, homeContext });
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.gardenHome?.ready === true, { timeout: 15000 });
  const homeColours = {};
  for (const mode of ['dark', 'light']) {
    await page.evaluate(mode => window.broker.pushTheme(mode), mode); await page.waitForTimeout(150);
    homeColours[mode] = await frame.evaluate(() => {
      const token = name => { const e = document.createElement('i'); e.style.background = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; };
      return { hero: getComputedStyle(document.getElementById('home-hero')).backgroundColor, raised: token('surface-raised'), graph: getComputedStyle(document.getElementById('home-graph')).backgroundColor, soft: token('surface-soft'),
        primary: getComputedStyle(document.querySelector('.home-actions .primary')).backgroundColor, cobalt: token('cobalt') };
    });
    assert(homeColours[mode].hero === homeColours[mode].raised && homeColours[mode].graph === homeColours[mode].soft && homeColours[mode].primary === homeColours[mode].cobalt, `${mode}: the Overview must use the theme's tokens: ${JSON.stringify(homeColours[mode])}.`);
    if (mode === 'dark') await page.screenshot({ path: '__OUTPUT__/overview-dark.png', fullPage: true });
  }
  assert(homeColours.dark.hero !== homeColours.light.hero, 'The theme must change the Overview.');
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(400);
  const stacked = await frame.evaluate(() => { const s = document.getElementById('home-side').getBoundingClientRect(), g = document.getElementById('home-graph').getBoundingClientRect();
    return { sideBottom: s.bottom, graphTop: g.top, graphWidth: g.width, width: innerWidth, scroll: document.scrollingElement.scrollWidth }; });
  assert(stacked.sideBottom <= stacked.graphTop + 1 && stacked.graphWidth >= stacked.width - 40 && stacked.scroll <= stacked.width, `At 700 px the side must stack over a full-width graph, with no sideways scroll: ${JSON.stringify(stacked)}.`);
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('overview in Light and Dark and at a narrow width');

  // 21. The Agenda (W-184), a screen of the tasks in the Garden package: the open tasks by when they
  // are due, each with its box and its note. A tick on a body task writes - [x] into the note's line
  // and the task in one batch; Undo takes both back; the note's name opens it in the Garden view.
  const dayFrom = days => { const d = new Date(); d.setDate(d.getDate() + days); const pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const isSunday = new Date().getDay() === 0;
  const agendaFixture = JSON.parse(JSON.stringify(fixture));
  const plantTask = agendaFixture.records['gd.task'].find(t => t.recordId === 'gd.task.start-here-d7ea1e7b');
  plantTask.values['gd.task.due'] = localToday();
  const manual = (id, title, due) => ({ entityId: 'gd.task', recordId: id, version: 1, labels: {}, exact: {}, calculated: {},
    values: { 'gd.task.title': title, 'gd.task.note': 'gd.note.daily-notes', 'gd.task.done': false, 'gd.task.source': 'Manual', 'gd.task.key': null, 'gd.task.due': due } });
  agendaFixture.records['gd.task'].push(manual('gd.task.w184-water', 'Water the beds', dayFrom(-2)), manual('gd.task.w184-soon', 'Sow the peas', dayFrom(1)), manual('gd.task.w184-bulbs', 'Order bulbs', dayFrom(30)));
  const agendaContext = { ...fixture.context, viewId: 'gd.task.agenda', kind: 'extensionRecordsSurface', entityId: 'gd.task', title: 'Agenda',
    bindings: { labelFieldId: 'gd.task.title', statusFieldId: null, fields: ['gd.task.due', 'gd.task.done', 'gd.task.note'], filters: [] } };
  await page.evaluate(({ agendaFixture, agendaContext }) => { window.broker.offerScreens(true); window.broker.setFixture({ ...agendaFixture, context: agendaContext }); window.broker.pushTheme('light'); window.broker.remount(); }, { agendaFixture, agendaContext });
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.gardenAgenda?.ready === true, { timeout: 15000 })
    .catch(async () => { throw Error(`The Agenda must start on gd.task.agenda: ${JSON.stringify(await frame.evaluate(() => ({ agenda: !!window.gardenAgenda, garden: !!window.garden, shown: !document.getElementById('agenda')?.hidden })))}.`); });
  const agendaShown = () => frame.evaluate(() => ({
    groups: [...document.querySelectorAll('#agenda-groups .list-group')].map(g => [g.dataset.group, [...g.querySelectorAll('.agenda-task')].map(r => r.dataset.id)]),
    summary: document.getElementById('agenda-summary').textContent,
    rows: [...document.querySelectorAll('.agenda-task')].map(r => ({ id: r.dataset.id, box: !!r.querySelector('input.box'), checked: r.querySelector('input.box').checked, done: r.classList.contains('done'),
      note: r.querySelector('.note-link')?.textContent ?? null, due: r.querySelector('.due')?.textContent ?? null, late: !!r.querySelector('.due.late'), bold: r.querySelectorAll('.text strong').length })),
  }));
  const noteTitle = id => fixture.records['gd.note'].find(n => n.recordId === id).values['gd.note.title'];
  const byNote = ids => ids.sort((a, b) => { const ta = agendaFixture.records['gd.task'].find(t => t.recordId === a), tb = agendaFixture.records['gd.task'].find(t => t.recordId === b);
    return noteTitle(ta.values['gd.task.note']).localeCompare(noteTitle(tb.values['gd.task.note'])) || ta.values['gd.task.title'].localeCompare(tb.values['gd.task.title']); });
  const wantGroups = [['overdue', ['gd.task.w184-water']], ['today', ['gd.task.start-here-d7ea1e7b']], ...(isSunday ? [] : [['week', ['gd.task.w184-soon']]]),
    ['later', isSunday ? ['gd.task.w184-soon', 'gd.task.w184-bulbs'] : ['gd.task.w184-bulbs']], ['none', byNote(['gd.task.start-here-c3140c01', 'gd.task.tags-and-tasks-8578540f'])]];
  const firstAgenda = await agendaShown();
  assert(JSON.stringify(firstAgenda.groups) === JSON.stringify(wantGroups), `The Agenda must group the open tasks by when they are due, soonest first, the done one left out: ${JSON.stringify({ shown: firstAgenda.groups, want: wantGroups })}.`);
  assert(firstAgenda.summary === '6 open tasks, 1 overdue.', `The Agenda says how many are open and overdue: ${firstAgenda.summary}.`);
  const plantRow = firstAgenda.rows.find(r => r.id === 'gd.task.start-here-d7ea1e7b'), waterRow = firstAgenda.rows.find(r => r.id === 'gd.task.w184-water');
  assert(firstAgenda.rows.every(r => r.box && !r.checked) && plantRow.note === 'Start here' && plantRow.due === null && plantRow.bold === 1 && waterRow.late && waterRow.note === noteTitle('gd.note.daily-notes'),
    `Each task has a box and its note; today's says no date, an overdue one says its date late, and Markdown is drawn: ${JSON.stringify(firstAgenda.rows)}.`);
  // A real pointer ticks the body task: one batch writes the line and the task, and the row stays, ticked.
  const agendaBatches = await requests('records.batch');
  await frame.locator('.agenda-task[data-id="gd.task.start-here-d7ea1e7b"] input.box').click();
  await page.waitForFunction(n => window.broker.requests.filter(r => r.m === 'records.batch').length > n, agendaBatches, { timeout: 3000 });
  await frame.waitForFunction(() => document.querySelector('.agenda-task[data-id="gd.task.start-here-d7ea1e7b"]')?.classList.contains('done'), null, { timeout: 3000 });
  const tickedNote = await page.evaluate(() => window.broker.record('gd.note', 'gd.note.start-here'));
  const tickedTask = await page.evaluate(() => window.broker.record('gd.task', 'gd.task.start-here-d7ea1e7b'));
  const agendaAfterTick = await agendaShown();
  assert(await requests('records.batch') === agendaBatches + 1, 'A tick must be exactly one records.batch.');
  assert(tickedNote.values['gd.note.body'].includes('- [x] Plant your first note with **New note**') && tickedTask.values['gd.task.done'] === true,
    `A tick on a body task must write - [x] into the note's line and mark the task done: ${JSON.stringify({ body: tickedNote.values['gd.note.body'].slice(0, 300), done: tickedTask.values['gd.task.done'] })}.`);
  assert(agendaAfterTick.summary === '5 open tasks, 1 overdue.' && agendaAfterTick.groups.find(g => g[0] === 'today')?.[1][0] === 'gd.task.start-here-d7ea1e7b', `The ticked task stays in Today, ticked, and no longer counts: ${JSON.stringify(agendaAfterTick)}.`);
  // Undo, on the line under the heading, takes both back as one step.
  const undosBeforeAgenda = await requests('records.undo');
  await frame.locator('#agenda-status [data-undo]').click();
  await page.waitForFunction(n => window.broker.requests.filter(r => r.m === 'records.undo').length > n, undosBeforeAgenda, { timeout: 3000 });
  await frame.waitForFunction(() => !document.querySelector('.agenda-task[data-id="gd.task.start-here-d7ea1e7b"]')?.classList.contains('done'), null, { timeout: 3000 });
  const undoneNote = await page.evaluate(() => window.broker.record('gd.note', 'gd.note.start-here'));
  const undoneTask = await page.evaluate(() => window.broker.record('gd.task', 'gd.task.start-here-d7ea1e7b'));
  assert(await requests('records.undo') === undosBeforeAgenda + 1 && undoneNote.values['gd.note.body'].includes('- [ ] Plant your first note with **New note**') && undoneTask.values['gd.task.done'] === false,
    `Undo must take the line and the task back as one records.undo: ${JSON.stringify({ done: undoneTask.values['gd.task.done'] })}.`);
  // A task added by hand ticks its record alone.
  const dailyBefore = (await page.evaluate(() => window.broker.record('gd.note', 'gd.note.daily-notes'))).version;
  await frame.locator('.agenda-task[data-id="gd.task.w184-water"] input.box').click();
  await page.waitForFunction(() => window.broker.record('gd.task', 'gd.task.w184-water')?.values['gd.task.done'] === true, null, { timeout: 3000 });
  assert((await page.evaluate(() => window.broker.record('gd.note', 'gd.note.daily-notes'))).version === dailyBefore, 'A task added by hand must tick its record and leave its note alone.');
  // The note's name opens it in the Garden view.
  await frame.locator('.agenda-task[data-id="gd.task.w184-bulbs"] .note-link').click();
  await page.waitForFunction(() => window.broker.screensOpened().at(-1) === 'gd.garden', null, { timeout: 2000 }).catch(() => undefined);
  const agendaHanded = await frame.evaluate(() => JSON.parse(localStorage.getItem('garden.handover.v1') ?? 'null'));
  assert((await page.evaluate(() => window.broker.screensOpened())).at(-1) === 'gd.garden' && agendaHanded?.open === 'gd.note.daily-notes', `The note's name must open it in the Garden view: ${JSON.stringify(agendaHanded)}.`);
  await frame.evaluate(() => localStorage.removeItem('garden.handover.v1'));
  await page.screenshot({ path: '__OUTPUT__/agenda.png', fullPage: true });
  const listColours = async (selector) => {
    const found = {};
    for (const mode of ['dark', 'light']) {
      await page.evaluate(mode => window.broker.pushTheme(mode), mode); await page.waitForTimeout(150);
      found[mode] = await frame.evaluate(selector => {
        const token = name => { const e = document.createElement('i'); e.style.color = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; };
        const group = document.querySelector(`${selector} .list-group`);
        const bg = name => { const e = document.createElement('i'); e.style.background = `var(--nendo-${name})`; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; };
        return { group: getComputedStyle(group).backgroundColor, raised: bg('surface-raised'), body: getComputedStyle(document.body).backgroundColor, surface: bg('surface'),
          today: document.querySelector('.group-today h2') ? getComputedStyle(document.querySelector('.group-today h2')).color : null, cobalt: token('cobalt'),
          overdue: document.querySelector('.group-overdue h2') ? getComputedStyle(document.querySelector('.group-overdue h2')).color : null, danger: token('danger') };
      }, selector);
      if (mode === 'dark') await page.screenshot({ path: `__OUTPUT__/${selector.slice(1)}-dark.png`, fullPage: true });
    }
    return found;
  };
  const agendaColours = await listColours('#agenda');
  for (const mode of ['dark', 'light']) {
    const c = agendaColours[mode];
    assert(c.group === c.raised && c.body === c.surface && c.today === c.cobalt && c.overdue === c.danger, `${mode}: the Agenda must use the theme's tokens: ${JSON.stringify(c)}.`);
  }
  assert(agendaColours.dark.group !== agendaColours.light.group, 'The theme must change the Agenda.');
  await page.setViewportSize({ width: 600, height: 900 });
  await page.waitForTimeout(300);
  const agendaNarrow = await frame.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, width: innerWidth }));
  assert(agendaNarrow.scroll <= agendaNarrow.width, `At 600 px the Agenda must not scroll sideways: ${JSON.stringify(agendaNarrow)}.`);
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('agenda: groups by due date, a real tick into the note and its Undo, a Manual tick, the note opened in the Garden view, Light and Dark');

  // 22. Tend (W-184), a screen of the notes: seeds and growing notes untended for the span chosen, the
  // longest first, and the notes not written yet. Its buttons write what the commands do, Undo takes
  // them back, and a span is kept.
  const tendFixture = JSON.parse(JSON.stringify(fixture));
  for (const n of tendFixture.records['gd.note']) n.values['gd.note.touched'] = localToday();
  const setNote = (id, values) => Object.assign(tendFixture.records['gd.note'].find(n => n.recordId === id).values, values);
  setNote('gd.note.daily-notes', { 'gd.note.touched': dayFrom(-40) });
  setNote('gd.note.tags-and-tasks', { 'gd.note.touched': dayFrom(-20), 'gd.note.stage': 'Seed' });
  setNote('gd.note.for-agents', { 'gd.note.touched': dayFrom(-200) }); // evergreen: never asked for
  tendFixture.records['gd.note'].push({ entityId: 'gd.note', recordId: 'gd.note.w184-stub', version: 1, labels: {}, exact: {}, calculated: {},
    values: { 'gd.note.title': 'Compost', 'gd.note.slug': 'compost', 'gd.note.kind': 'Note', 'gd.note.stage': 'Seed', 'gd.note.pinned': false, 'gd.note.touched': dayFrom(-3), 'gd.note.body': null } });
  const tendContext = { ...fixture.context, viewId: 'gd.note.tend', kind: 'extensionRecordsSurface', entityId: 'gd.note', title: 'Tend',
    bindings: { labelFieldId: 'gd.note.title', statusFieldId: 'gd.note.stage', fields: ['gd.note.touched', 'gd.note.kind'], filters: [] } };
  await page.evaluate(({ tendFixture, tendContext }) => { window.broker.setFixture({ ...tendFixture, context: tendContext }); window.broker.pushTheme('light'); window.broker.remount(); }, { tendFixture, tendContext });
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.evaluate(() => localStorage.removeItem('garden.tend.span.v1'));
  await page.evaluate(() => window.broker.remount());
  await page.waitForTimeout(300);
  frame = await mounted();
  await frame.waitForFunction(() => window.gardenTend?.ready === true, { timeout: 15000 })
    .catch(async () => { throw Error(`Tend must start on gd.note.tend: ${JSON.stringify(await frame.evaluate(() => ({ tend: !!window.gardenTend, garden: !!window.garden, shown: !document.getElementById('tend')?.hidden })))}.`); });
  const tendShown = () => frame.evaluate(() => ({
    quiet: [...document.querySelectorAll('#tend-quiet .tend-note')].map(r => ({ id: r.dataset.id, when: r.querySelector('.tend-when').textContent, actions: [...r.querySelectorAll('[data-action]')].map(b => b.textContent) })),
    empty: [...document.querySelectorAll('#tend-empty .tend-note')].map(r => r.dataset.id), emptyShown: !document.getElementById('tend-empty-section').hidden,
    spans: [...document.querySelectorAll('#tend-spans button')].map(b => [b.textContent, b.getAttribute('aria-pressed')]),
  }));
  const firstTend = await tendShown();
  assert(JSON.stringify(firstTend.quiet.map(r => r.id)) === JSON.stringify(['gd.note.daily-notes', 'gd.note.tags-and-tasks']) && JSON.stringify(firstTend.empty) === JSON.stringify(['gd.note.w184-stub']) && firstTend.emptyShown,
    `Tend must ask for the seed and growing notes untended for two weeks, the longest first, and the note not written yet: ${JSON.stringify(firstTend)}.`);
  assert(firstTend.quiet[0].when === 'Growing · 5 weeks untended' && JSON.stringify(firstTend.quiet[0].actions) === JSON.stringify(['Tended today', 'Mark evergreen'])
    && JSON.stringify(firstTend.quiet[1].actions) === JSON.stringify(['Tended today', 'Mark growing']), `Each note says how long it waited and offers the next stage: ${JSON.stringify(firstTend.quiet)}.`);
  assert(JSON.stringify(firstTend.spans) === JSON.stringify([['1 week', 'false'], ['2 weeks', 'true'], ['1 month', 'false'], ['3 months', 'false']]), `Two weeks is the span to start with: ${JSON.stringify(firstTend.spans)}.`);
  await frame.locator('#tend-spans button[data-span="30"]').click();
  const monthTend = await tendShown();
  assert(JSON.stringify(monthTend.quiet.map(r => r.id)) === JSON.stringify(['gd.note.daily-notes']) && await frame.evaluate(() => localStorage.getItem('garden.tend.span.v1')) === '30',
    `A month asks for fewer, and the span is kept: ${JSON.stringify(monthTend)}.`);
  await frame.locator('#tend-spans button[data-span="14"]').click();
  // A real pointer marks the seed growing: one batch, the stage and today's date; it leaves the list.
  const tendBatches = await requests('records.batch');
  await frame.locator('.tend-note[data-id="gd.note.tags-and-tasks"] [data-action="growing"]').click();
  await page.waitForFunction(n => window.broker.requests.filter(r => r.m === 'records.batch').length > n, tendBatches, { timeout: 3000 });
  await frame.waitForFunction(() => !document.querySelector('.tend-note[data-id="gd.note.tags-and-tasks"]'), null, { timeout: 3000 });
  const grown = await page.evaluate(() => window.broker.record('gd.note', 'gd.note.tags-and-tasks'));
  assert(await requests('records.batch') === tendBatches + 1 && grown.values['gd.note.stage'] === 'Growing' && grown.values['gd.note.touched'] === localToday(),
    `Mark growing must be one batch that sets the stage and tends the note today: ${JSON.stringify(grown.values)}.`);
  const tendUndos = await requests('records.undo');
  await frame.locator('#tend-status [data-undo]').click();
  await page.waitForFunction(n => window.broker.requests.filter(r => r.m === 'records.undo').length > n, tendUndos, { timeout: 3000 });
  await frame.waitForFunction(() => !!document.querySelector('.tend-note[data-id="gd.note.tags-and-tasks"]'), null, { timeout: 3000 });
  const ungrown = await page.evaluate(() => window.broker.record('gd.note', 'gd.note.tags-and-tasks'));
  assert(ungrown.values['gd.note.stage'] === 'Seed' && ungrown.values['gd.note.touched'] === dayFrom(-20), `Undo must put the stage and the date back: ${JSON.stringify(ungrown.values)}.`);
  await frame.locator('.tend-note[data-id="gd.note.daily-notes"] [data-action="tend"]').click();
  await page.waitForFunction(today => window.broker.record('gd.note', 'gd.note.daily-notes')?.values['gd.note.touched'] === today, localToday(), { timeout: 3000 });
  assert((await page.evaluate(() => window.broker.record('gd.note', 'gd.note.daily-notes'))).values['gd.note.stage'] === 'Growing', 'Tended today keeps the stage.');
  await frame.locator('.tend-note[data-id="gd.note.w184-stub"] .note-link').click();
  await page.waitForFunction(() => window.broker.screensOpened().at(-1) === 'gd.garden', null, { timeout: 2000 }).catch(() => undefined);
  const tendHanded = await frame.evaluate(() => JSON.parse(localStorage.getItem('garden.handover.v1') ?? 'null'));
  assert(tendHanded?.open === 'gd.note.w184-stub', `A note's title must open it in the Garden view: ${JSON.stringify(tendHanded)}.`);
  await frame.evaluate(() => { localStorage.removeItem('garden.handover.v1'); localStorage.removeItem('garden.tend.span.v1'); });
  await page.screenshot({ path: '__OUTPUT__/tend.png', fullPage: true });
  const tendColours = await listColours('#tend');
  for (const mode of ['dark', 'light']) {
    const c = tendColours[mode];
    assert(c.group === c.raised && c.body === c.surface, `${mode}: Tend must use the theme's tokens: ${JSON.stringify(c)}.`);
  }
  assert(tendColours.dark.group !== tendColours.light.group, 'The theme must change Tend.');
  await page.setViewportSize({ width: 600, height: 900 });
  await page.waitForTimeout(300);
  const tendNarrow = await frame.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, width: innerWidth }));
  assert(tendNarrow.scroll <= tendNarrow.width, `At 600 px Tend must not scroll sideways: ${JSON.stringify(tendNarrow)}.`);
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('tend: untended seeds and growing notes by span, notes not written yet, Mark growing and its Undo, Tended today, Light and Dark');

  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, colours, diagramColours, narrow, settle, checks, errors };

  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
