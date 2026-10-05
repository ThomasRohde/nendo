async page => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
  const pass = name => checks.push(name);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__BROKER_URL__');
  await page.evaluate(fixture => { window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.setFixture(fixture); }, '__FLOW_FIXTURE__');
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  const frame = await new Promise(async (resolve, reject) => {
    for (let i = 0; i < 200; i++) { const f = page.frames().find(f => f.url().startsWith(origin + '/')); if (f) { resolve(f); return; } await page.waitForTimeout(50); }
    reject(Error('Flow frame did not mount.'));
  });
  await frame.waitForFunction(() => window.flowApp?.draft?.steps?.length === 8, null, { timeout: 15000 });
  await frame.waitForFunction(() => document.querySelectorAll('.react-flow__edge').length === 9, null, { timeout: 5000 });
  const command = (id, value) => page.evaluate(({ id, value }) => window.broker.command(id, value), { id, value });
  const records = entity => page.evaluate(entity => window.broker.records(entity), entity);
  const requests = method => page.evaluate(method => window.broker.requests.filter(r => r.m === method), method);
  const toolbarText = () => page.evaluate(() => { const t = window.broker.toolbars.at(-1); return (t?.items ?? []).filter(i => i.kind === 'text').map(i => i.text).join(' '); });
  // api.js sends the latest toolbar at most every 100 ms, so a check waits for the text it expects.
  const toolbarSays = text => page.waitForFunction(text => (window.broker.toolbars.at(-1)?.items ?? []).some(i => i.kind === 'text' && i.text === text), text, { timeout: 2000 })
    .catch(async () => assert(false, `Toolbar status: ${await toolbarText()} (expected ${text})`));
  const refusals = () => page.evaluate(() => window.broker.chromeRefusals);
  const state = () => frame.evaluate(() => ({ dirty: window.flowApp.dirty, problems: window.flowApp.problems.map(p => p.message), steps: window.flowApp.draft.steps.length, edges: window.flowApp.draft.edges.length }));

  // Wide layout: the canvas takes the room, the side panel keeps 340 px, nothing scrolls sideways.
  const geometry = () => frame.evaluate(() => {
    const box = id => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { canvas: box('canvas'), side: box('side'), width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  const wide = await geometry();
  assert(wide.canvas.width > 900 && wide.canvas.height > 700 && Math.round(wide.side.width) === 340 && wide.overflow <= 1, `Wide geometry: ${JSON.stringify(wide)}`);
  assert(await frame.locator('.react-flow__node').count() === 8, 'Every step is drawn.');
  assert((await refusals()).length === 0, 'Nendo refused the toolbar: ' + JSON.stringify(await refusals()));
  assert(await frame.locator('#problems li.clear').count() === 1, 'The sample flow reads as walkable.');
  await toolbarSays('Saved · walkable');
  pass('wide layout, 8 steps and 9 edges drawn, walkable, toolbar accepted');
  await page.screenshot({ path: '__OUTPUT__/flow-light.png' });

  // The fixture's run is part-way: its step is marked, the two edges it took are drawn as taken.
  await frame.waitForFunction(() => document.querySelector('.react-flow__node[data-id="fl_step_defect_fix"] .step.current'));
  assert(await frame.locator('.react-flow__edge.taken').count() === 2, `Taken edges: ${await frame.locator('.react-flow__edge.taken').count()}`);
  assert(await frame.locator('.run-card .outcomes button').count() === 1, 'The run offers the one edge leaving Fix it.');
  await frame.locator('.run-card .outcomes button', { hasText: 'fixed' }).click();
  await page.waitForFunction(() => window.broker.requests.some(r => r.m === 'records.update'), null, { timeout: 3000 }).catch(() => {});
  const moved = (await requests('records.update')).at(-1);
  assert(moved?.p?.values?.['fl.run.choice'] === 'fl_edge_defect_fix_guard' && moved.p.targetVersions?.['fl.run.choice'] === 1, `Choosing wrote: ${JSON.stringify(moved)}`);
  pass('run overlay on its current step and taken edges; choosing an outcome writes fl.run.choice with the edge version');

  // Select a step with a real pointer and edit it in the inspector.
  await frame.locator('.react-flow__node[data-id="fl_step_defect_record"]').click();
  await frame.waitForFunction(() => document.getElementById('inspector-title').textContent === 'Step');
  assert(await frame.locator('#inspector input').first().inputValue() === 'Record a Finding', 'The inspector shows the selected step.');
  await frame.getByLabel('Done when').fill('The Finding exists, quotes the failure and names the lane.');
  assert((await state()).dirty, 'Editing marks a draft.');
  await toolbarSays('Unsaved changes');
  pass('pointer selection opens the inspector; an edit marks the draft');

  // Add a step: it is flagged until it is connected both ways.
  await command('add-step');
  await frame.waitForFunction(() => window.flowApp.draft.steps.length === 9);
  let s = await state();
  assert(s.problems.some(m => m.includes('“New step” has no way out')) && s.problems.some(m => m.includes('“New step” cannot be reached')), `Problems: ${s.problems}`);
  const added = await frame.evaluate(() => window.flowApp.draft.steps.find(x => x.name === 'New step'));
  assert(added.key === 'defect.new-step', `New key: ${added.key}`);
  // Connect with the pointer: from Record's source handle to the new step, and from the new step to Done.
  const drag = async (fromId, toId) => {
    const from = await frame.locator(`.react-flow__node[data-id="${fromId}"] .react-flow__handle.source[data-handleid="out"]`).boundingBox();
    const to = await frame.locator(`.react-flow__node[data-id="${toId}"] .react-flow__handle.target[data-handleid="in"]`).boundingBox();
    const offset = await page.evaluate(() => { const b = document.querySelector('iframe').getBoundingClientRect(); return { x: b.x, y: b.y }; });
    await page.mouse.move(offset.x + from.x + from.width / 2, offset.y + from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(offset.x + to.x + to.width / 2, offset.y + to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
  };
  await frame.locator('.react-flow__controls-fitview').click(); await page.waitForTimeout(300);
  await drag('fl_step_defect_record', added.id);
  await frame.waitForFunction(() => window.flowApp.draft.edges.length === 10);
  await drag(added.id, 'fl_step_defect_done');
  await frame.waitForFunction(() => window.flowApp.draft.edges.length === 11);
  s = await state();
  assert(!s.problems.some(m => m.includes('no way out') || m.includes('cannot be reached')), `Still flagged: ${s.problems}`);
  assert(s.problems.some(m => m === 'Say what to do at “New step”.'), `A step without instructions is flagged: ${s.problems}`);
  await frame.locator(`.react-flow__node[data-id="${added.id}"]`).click();
  await frame.getByLabel('Instructions').fill('Tell the owner the Finding is recorded.');
  s = await state();
  assert(!s.problems.length, `Still flagged: ${s.problems}`);
  const fromRecord = await frame.evaluate(() => window.flowApp.draft.edges.filter(e => e.from === 'fl_step_defect_record').map(e => e.outcome).sort());
  assert(JSON.stringify(fromRecord) === JSON.stringify(['next', 'recorded']), `Outcomes from Record: ${fromRecord}`);
  pass('add step, connect by pointer both ways; the new edge takes an outcome no sibling uses');

  // A refused save keeps the draft and says so.
  await page.evaluate(() => window.broker.fail('records.batch', { code: 'stale-record', message: 'The step changed elsewhere.' }, 1));
  await command('save');
  await frame.waitForFunction(() => !document.getElementById('problem').hidden);
  assert((await state()).dirty && (await frame.locator('#problem').textContent()).includes('Your draft is kept'), 'A refused save kept the draft.');
  // Then one batch saves it all.
  const before = (await requests('records.batch')).length;
  await command('save');
  await frame.waitForFunction(() => !window.flowApp.dirty, null, { timeout: 5000 });
  assert((await requests('records.batch')).length === before + 1, 'Save is one batch.');
  const saved = (await records('fl.step')).find(r => r.values['fl.step.key'] === 'defect.new-step');
  assert(saved && saved.values['fl.step.kind'] === 'Step' && saved.values['fl.step.flow'] === 'fl_flow_defect', `Stored step: ${JSON.stringify(saved)}`);
  assert((await records('fl.step')).find(r => r.recordId === 'fl_step_defect_record').values['fl.step.doneWhen'].includes('names the lane'), 'The edited step was stored.');
  assert((await records('fl.edge')).filter(r => r.values['fl.edge.from'] === saved.recordId || r.values['fl.edge.to'] === saved.recordId).length === 2, 'Both new edges were stored.');
  assert(await frame.locator('#inspector input:not([readonly]), #inspector textarea:not([readonly])').count() > 0,
    'After the save reloaded the file, the inspector was left read-only.');
  pass('a refused save keeps the draft; Save stores steps and edges in one batch; the inspector stays editable after it');

  // Delete the new step with the keyboard: its edges go with it, and the save deletes them first.
  await frame.locator(`.react-flow__node[data-id="${saved.recordId}"]`).click();
  await page.keyboard.press('Delete');
  await frame.waitForFunction(() => window.flowApp.draft.steps.length === 8 && window.flowApp.draft.edges.length === 9);
  await command('save');
  await frame.waitForFunction(() => !window.flowApp.dirty);
  const deletes = (await requests('records.batch')).at(-1).p.writes.filter(w => w.op === 'delete').map(w => w.entityId);
  assert(JSON.stringify(deletes) === JSON.stringify(['fl.edge', 'fl.edge', 'fl.step']), `Delete order: ${deletes}`);
  pass('Delete removes a step with its edges; edges are deleted before the step');

  // Dark theme: the canvas and a step take the Workbench's dark tokens.
  await page.evaluate(() => window.broker.pushTheme('dark'));
  await page.waitForTimeout(150);
  const colours = await frame.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return { canvas: css.getPropertyValue('--nendo-canvas').trim(), surface: css.getPropertyValue('--nendo-surface').trim(),
      flow: getComputedStyle(document.querySelector('.react-flow')).backgroundColor, step: getComputedStyle(document.querySelector('.react-flow__node[data-id="fl_step_defect_record"] .step')).backgroundColor,
      mode: document.documentElement.dataset.nendoTheme };
  });
  const rgb = hex => { const n = parseInt(hex.replace('#', ''), 16); return `rgb(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255})`; };
  assert(colours.mode === 'dark' && colours.flow === rgb(colours.canvas) && colours.step === rgb(colours.surface), `Dark colours: ${JSON.stringify(colours)}`);
  await page.screenshot({ path: '__OUTPUT__/flow-dark.png' });
  await page.evaluate(() => window.broker.pushTheme('light'));
  pass('dark theme: canvas and steps use the dark tokens');

  // Narrow: the panel stacks under the canvas and nothing scrolls sideways.
  await page.setViewportSize({ width: 700, height: 900 }); await page.waitForTimeout(200);
  const narrow = await geometry();
  assert(narrow.side.y >= narrow.canvas.y + narrow.canvas.height - 1 && narrow.canvas.height >= 359 && narrow.overflow <= 1, `Narrow geometry: ${JSON.stringify(narrow)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  pass('narrow layout stacks without horizontal overflow');

  // A new flow starts walkable: Start, one step, End, two edges, one batch.
  await command('new-flow');
  await frame.locator('#new-flow-dialog').getByLabel('Name', { exact: true }).fill('Release the installer');
  await frame.getByRole('button', { name: 'Create flow' }).click();
  await frame.waitForFunction(() => window.flowApp.draft?.name === 'Release the installer');
  const created = (await requests('records.batch')).at(-1).p.writes.map(w => w.entityId);
  assert(JSON.stringify(created) === JSON.stringify(['fl.flow', 'fl.step', 'fl.step', 'fl.step', 'fl.edge', 'fl.edge']), `New flow writes: ${created}`);
  assert((await state()).problems.length === 0, `New flow problems: ${(await state()).problems}`);
  assert((await records('fl.flow')).some(r => r.values['fl.flow.key'] === 'release-the-installer'), 'The new flow has its key.');
  pass('New flow creates a walkable Start, step and End in one batch');

  assert(errors.length === 0, 'Page errors: ' + JSON.stringify(errors));
  return { complete: true, checks, errors };
}
