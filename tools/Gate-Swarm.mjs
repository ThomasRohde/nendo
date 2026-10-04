async page => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__BROKER_URL__');
  await page.evaluate(fixture => { window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.setFixture(fixture); }, '__SWARM_FIXTURE__');
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  const frame = await new Promise(async (resolve, reject) => {
    for (let i = 0; i < 200; i++) { const f = page.frames().find(f => f.url().startsWith(origin + '/')); if (f) { resolve(f); return; } await page.waitForTimeout(50); }
    reject(Error('Swarm frame did not mount.'));
  });
  await frame.waitForFunction(() => window.swarm?.model?.species, { timeout: 15000 });
  const command = id => page.evaluate(id => window.broker.command(id), id);
  const record = (entity, id) => page.evaluate(({ entity, id }) => window.broker.records(entity).find(r => r.recordId === id), { entity, id });
  const geometry = () => frame.evaluate(() => {
    const box = id => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { habitat: box('habitat'), diagram: box('diagram'), width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  const opened = await geometry(); assert(opened.habitat.width > 450 && opened.diagram.width > 400 && opened.overflow <= 1, `Wide layout geometry: ${JSON.stringify(opened)}`);
  assert(await frame.evaluate(() => window.swarm.tick === 0), 'The simulation must open paused.');
  assert((await page.evaluate(() => window.broker.chromeRefusals)).length === 0, 'Nendo refused Swarm toolbar declarations: ' + JSON.stringify(await page.evaluate(() => window.broker.chromeRefusals)));
  await command('play'); await frame.waitForFunction(() => window.swarm.tick > 65);
  await command('play'); const paused = await frame.evaluate(() => window.swarm.tick); await page.waitForTimeout(150);
  assert(await frame.evaluate(tick => window.swarm.tick === tick, paused), 'Pause did not stop fixed steps.');
  await frame.locator('#habitat').click({ position: { x: 220, y: 180 } });
  assert(await frame.evaluate(() => window.swarm.snapshot.events.length === 1), 'Pointer disturbance was not captured.');
  await command('play'); await frame.waitForFunction(tick => window.swarm.tick > tick + 70, paused); await command('play');
  const digest = await frame.evaluate(() => window.swarm.digest);
  await command('save-experiment'); await frame.getByLabel('Name', { exact: true }).fill('First flock'); await frame.getByRole('button', { name: 'Save experiment', exact: true }).click();
  await frame.waitForFunction(() => document.querySelectorAll('.experiment-row').length === 1);
  assert((await page.evaluate(() => window.broker.records('sw.experiment'))).length === 1, 'Experiment did not reach typed records.');
  // Edit an action through the real bpmn-js selection and inspector.
  await frame.locator('[data-element-id="sw_murmuration_gather"] > .djs-hit').click({ position: { x: 22, y: 16 } });
  await page.waitForTimeout(100);
  assert(JSON.stringify(await frame.locator('.djs-context-pad.open [data-action]').evaluateAll(items => items.map(e => e.dataset.action).sort())) === JSON.stringify(['connect', 'remove']), 'Swarm must expose only its two supported graph controls.');
  assert(await frame.locator('#inspector select').count() === 1, 'Node inspector did not open: ' + JSON.stringify(await frame.evaluate(() => ({ html: document.querySelector('#inspector').innerHTML, problem: document.querySelector('#problem').textContent }))) + ' errors: ' + JSON.stringify(errors));
  await frame.locator('#inspector').getByLabel('Action', { exact: true }).selectOption('Rest');
  assert(await frame.evaluate(() => window.swarm.dirty), 'Editing the action did not mark a draft.');
  await command('play'); await frame.waitForFunction(() => window.swarm.tick > 65 && window.swarm.metrics.states.Rest > 0); await command('play');
  const batches = () => page.evaluate(() => window.broker.requests.filter(r => r.m === 'records.batch').length);
  const before = await batches(); await command('save-behaviour');
  await frame.waitForFunction(() => !window.swarm.dirty);
  assert(await batches() === before + 1, 'Save behaviour did not use exactly one typed batch.');
  assert((await record('sw.node', 'sw_murmuration_gather')).values['sw.node.action'] === 'Rest', 'Edited action was not stored.');
  // Replay the captured run after its live rules have changed.
  await frame.getByRole('button', { name: 'Replay', exact: true }).click();
  await frame.waitForFunction(() => document.querySelector('#run-state').textContent === 'Captured run');
  const capturedNodes = await frame.evaluate(() => window.swarm.model.nodes);
  const capturedShape = frame.locator('[data-element-id="sw_murmuration_gather"] > .djs-hit');
  const capturedBox = await capturedShape.boundingBox();
  await page.mouse.move(capturedBox.x + 20, capturedBox.y + 20); await page.mouse.down();
  await page.mouse.move(capturedBox.x + 55, capturedBox.y + 40, { steps: 5 }); await page.mouse.up();
  assert(JSON.stringify(await frame.evaluate(() => window.swarm.model.nodes)) === JSON.stringify(capturedNodes), 'Dragging changed the captured read-only graph.');
  assert(JSON.stringify(await frame.evaluate(() => window.swarm.digest)) === JSON.stringify(digest), 'Captured experiment used current rules or lost its disturbance.');
  await frame.getByRole('button', { name: 'Reload saved' }).click();
  await frame.waitForFunction(() => document.querySelector('#run-state').textContent === 'Paused');
  // A refused batch retains the draft and does not silently relabel it Saved.
  await frame.getByLabel('Speed', { exact: true }).fill('2.7'); await frame.getByLabel('Speed', { exact: true }).dispatchEvent('change');
  await page.evaluate(() => window.broker.fail('records.batch', { code: 'stale-record', message: 'The species changed elsewhere.' }, 1));
  await command('save-behaviour');
  await frame.waitForFunction(() => document.querySelector('#problem').textContent.includes('draft is kept'));
  assert(await frame.evaluate(() => window.swarm.dirty), 'A refused save discarded the draft.');
  assert((await record('sw.species', 'sw_species_fireflies')).values['sw.species.speed'] !== 2.7, 'Refused save changed another species.');
  await frame.getByRole('button', { name: 'Reload saved' }).click(); await frame.waitForFunction(() => !window.swarm.dirty);
  await frame.getByLabel('Speed', { exact: true }).fill('2.4'); await frame.getByLabel('Speed', { exact: true }).dispatchEvent('change');
  await page.evaluate(() => window.broker.pushChanges()); await frame.waitForFunction(() => document.querySelector('#status').textContent.includes('changed elsewhere'));
  const blockedBefore = await batches(); await command('save-behaviour');
  assert(await batches() === blockedBefore, 'An external change was overwritten by the old draft.');
  await frame.getByRole('button', { name: 'Reload saved' }).click(); await frame.waitForFunction(() => !window.swarm.dirty);
  // The custom palette and context-pad connection must edit the real graph.
  const nodeIds = await frame.evaluate(() => window.swarm.model.nodes.map(n => n.id));
  await frame.getByRole('button', { name: '+ Action', exact: true }).click();
  const addedId = await frame.evaluate(ids => window.swarm.model.nodes.find(n => !ids.includes(n.id)).id, nodeIds);
  assert(await frame.evaluate(id => window.swarm.model.nodes.find(n => n.id === id)?.name === 'Wander', addedId), 'New actions must carry their visible name in the actual model.');
  await frame.getByRole('button', { name: 'Fit', exact: true }).click();
  await frame.locator('[data-element-id="sw_murmuration_gather"] > .djs-hit').click({ position: { x: 22, y: 12 } });
  await frame.locator('.djs-context-pad.open [data-action="connect"]').click();
  await frame.locator(`[data-element-id="${addedId}"] > .djs-hit`).click({ position: { x: 60, y: 48 } });
  assert(await frame.evaluate(id => window.swarm.model.links.some(l => l.source === 'sw_murmuration_gather' && l.target === id), addedId), 'The custom connect control did not create a graph transition.');
  await command('play');
  await frame.waitForFunction(() => document.querySelector('#problem').textContent.includes('exactly one outgoing'));
  // diagram-js suppresses the click immediately following a completed connection.
  await page.waitForTimeout(600);
  await frame.locator(`[data-element-id="${addedId}"] > .djs-hit`).click({ position: { x: 60, y: 48 } });
  assert(await frame.locator('#inspector select[aria-label="Action"]').count() === 1, 'Removal did not select the new action: ' + JSON.stringify(await frame.evaluate(id => ({ id, node: window.swarm.model.nodes.find(n => n.id === id), context: document.querySelector('.djs-context-pad.open')?.outerHTML, inspector: document.querySelector('#inspector').innerHTML }), addedId)));
  await frame.locator('.djs-context-pad.open [data-action="remove"]').click();
  await frame.waitForFunction(id => !window.swarm.model.nodes.some(n => n.id === id) && !window.swarm.model.links.some(l => l.target === id), addedId, { timeout: 3000 }).catch(async () => { throw Error('Remove left the temporary node or its transition behind: ' + JSON.stringify(await frame.evaluate(id => ({ addedId: id, nodes: window.swarm.model.nodes.map(n => n.id), links: window.swarm.model.links.map(l => [l.source, l.target]), inspector: document.querySelector('#inspector').textContent }), addedId))); });
  await frame.getByRole('button', { name: 'Reload saved' }).click(); await frame.waitForFunction(() => !window.swarm.dirty);
  // Reloading the frame keeps saved records and replays the same result.
  await page.evaluate(() => window.broker.remount());
  await page.waitForTimeout(350);
  const reopened = page.frames().find(f => f.url().startsWith(origin + '/'));
  await reopened.waitForFunction(() => window.swarm?.model?.species);
  await reopened.locator('#experiments').evaluate(e => { e.open = true; });
  await reopened.getByRole('button', { name: 'Replay', exact: true }).click();
  await reopened.waitForFunction(() => document.querySelector('#run-state').textContent === 'Captured run');
  assert(JSON.stringify(await reopened.evaluate(() => window.swarm.digest)) === JSON.stringify(digest), 'Reopen did not preserve the captured experiment.');
  await reopened.getByRole('button', { name: 'Reload saved' }).click(); await reopened.waitForFunction(() => window.swarm.tick === 0);
  const colours = {};
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => window.broker.pushTheme(mode), mode); await page.waitForTimeout(100);
    colours[mode] = await reopened.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color,
      states: [...document.querySelectorAll('.dot')].map(e => getComputedStyle(e).backgroundColor),
      expected: ['cobalt', 'healthy', 'warning', 'danger', 'tone-violet'].map(token => { const e = document.createElement('i'); e.style.color = `var(--nendo-${token})`; document.body.append(e); const colour = getComputedStyle(e).color; e.remove(); return colour; }) }));
    assert(new Set(colours[mode].states).size === 5, `${mode}: creature states do not have five distinct theme colours: ${JSON.stringify(colours[mode])}`);
    assert(JSON.stringify(colours[mode].states) === JSON.stringify(colours[mode].expected), `${mode}: the state legend kept colours from the previous theme.`);
    await page.screenshot({ path: '__OUTPUT__/' + mode + '.png', fullPage: true });
  }
  assert(colours.light.background !== colours.dark.background && colours.light.ink !== colours.dark.ink, 'Effective theme did not change the frame.');
  await page.setViewportSize({ width: 620, height: 1000 }); await page.waitForTimeout(100);
  const narrow = await reopened.evaluate(() => { const a = document.querySelector('#habitat').getBoundingClientRect(), b = document.querySelector('#diagram').getBoundingClientRect(); return { habitatBottom: a.bottom, diagramTop: b.top, width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }; });
  assert(narrow.diagramTop > narrow.habitatBottom && narrow.overflow <= 1, `Narrow panes must stack without overflow: ${JSON.stringify(narrow)}`);
  await page.screenshot({ path: '__OUTPUT__/narrow.png', fullPage: true });
  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, opened, narrow, colours, pausedStep: paused, checks: ['paused opening', 'geometry', 'play/pause', 'disturbance', 'graph changes motion', 'one-batch save', 'captured replay', 'refused save retains draft', 'external change blocks overwrite', 'add/connect/remove', 'invalid graph refusal', 'reopen', 'Light/Dark', 'narrow layout'], errors };
}
