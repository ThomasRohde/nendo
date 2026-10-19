async page => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('__BROKER_URL__');
  const swarmFixture = '__SWARM_FIXTURE__';
  await page.evaluate(fixture => { window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.setFixture(fixture); }, swarmFixture);
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
  // Somebody else's change moves the file's change sequence on, as every change in Nendo does (the view ignores a sequence its own save already read).
  await page.evaluate(() => { window.broker.touch('sw.species', 'sw_species_fireflies'); window.broker.pushChanges(); }); await frame.waitForFunction(() => document.querySelector('#status').textContent.includes('changed elsewhere'));
  const blockedBefore = await batches(); await command('save-behaviour');
  assert(await batches() === blockedBefore, 'An external change was overwritten by the old draft.');
  await frame.getByRole('button', { name: 'Reload saved' }).click(); await frame.waitForFunction(() => !window.swarm.dirty);
  // A save kept but not read back says so, never that nothing was saved.
  const speciesId = await frame.evaluate(() => window.swarm.model.species.id);
  await frame.getByLabel('Speed', { exact: true }).fill('2.6'); await frame.getByLabel('Speed', { exact: true }).dispatchEvent('change');
  await page.evaluate(() => window.broker.fail('records.query', { code: 'host-timeout', message: 'The Desktop host did not respond.' }, 1));
  await command('save-behaviour');
  await frame.waitForFunction(() => !document.querySelector('#problem').hidden);
  const unread = await frame.evaluate(() => document.querySelector('#problem').textContent);
  assert(/saved, but reading it back failed/.test(unread) && !/not saved/.test(unread), `A kept save must not be called unsaved: ${unread}`);
  assert((await record('sw.species', speciesId)).values['sw.species.speed'] === 2.6, 'The batch before the failed read must be kept.');
  assert(!(await frame.evaluate(() => window.swarm.dirty)), 'A kept save is no longer a draft.');
  await frame.getByRole('button', { name: 'Reload saved' }).click(); await frame.waitForFunction(() => !window.swarm.dirty && document.querySelector('#problem').hidden);
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
  // An unsaved behaviour outlasts the view: started again, it comes back, unsaved.
  await frame.getByLabel('Speed', { exact: true }).fill('2.9'); await frame.getByLabel('Speed', { exact: true }).dispatchEvent('change');
  await page.waitForTimeout(400);
  const keptBefore = await batches();
  // A remounted view is a new frame that reports about:blank until its navigation commits,
  // so each remount polls for it rather than looking once after a fixed wait.
  const remounted = async (...previous) => {
    for (let i = 0; i < 200; i++) {
      const next = page.frames().find(f => f.url().startsWith(origin + '/') && !previous.includes(f));
      if (next) return next;
      await page.waitForTimeout(50);
    }
    throw Error('The Swarm view did not mount again within ten seconds of a remount.');
  };
  await page.evaluate(() => window.broker.remount());
  const restarted = await remounted(frame);
  await restarted.waitForFunction(() => window.swarm?.model?.species);
  const recovered = await restarted.evaluate(() => ({ dirty: window.swarm.dirty, speed: window.swarm.model.species.speed, field: document.getElementById('speed').value, status: document.getElementById('status').textContent }));
  assert(recovered.dirty && recovered.speed === 2.9 && recovered.field === '2.9' && /kept from before/.test(recovered.status), `The unsaved behaviour must come back when the view starts again: ${JSON.stringify(recovered)}`);
  assert(await batches() === keptBefore && (await record('sw.species', speciesId)).values['sw.species.speed'] !== 2.9, 'Keeping a draft must never save it.');
  await restarted.getByRole('button', { name: 'Reload saved' }).click(); await restarted.waitForFunction(() => !window.swarm.dirty);
  await page.evaluate(() => window.broker.remount());
  const clean = await remounted(frame, restarted);
  await clean.waitForFunction(() => window.swarm?.model?.species);
  assert(!(await clean.evaluate(() => window.swarm.dirty)), 'Reload saved must discard the kept draft.');
  // Reloading the frame keeps saved records and replays the same result.
  await page.evaluate(() => window.broker.remount());
  const reopened = await remounted(frame, restarted, clean);
  await reopened.waitForFunction(() => window.swarm?.model?.species);
  await reopened.locator('#experiments').evaluate(e => { e.open = true; });
  await reopened.getByRole('button', { name: 'Replay', exact: true }).click();
  await reopened.waitForFunction(() => document.querySelector('#run-state').textContent === 'Captured run');
  assert(JSON.stringify(await reopened.evaluate(() => window.swarm.digest)) === JSON.stringify(digest), 'Reopen did not preserve the captured experiment.');
  await reopened.getByRole('button', { name: 'Reload saved' }).click(); await reopened.waitForFunction(() => window.swarm.tick === 0);
  // ---- Saved experiments are listed newest first. Two more runs after "First flock".
  const saveRun = async name => {
    await command('save-experiment');
    await reopened.getByLabel('Name', { exact: true }).fill(name);
    await reopened.getByRole('button', { name: 'Save experiment', exact: true }).click();
    await reopened.waitForFunction(wanted => [...document.querySelectorAll('.experiment-copy')].some(row => row.firstChild.textContent === wanted), name);
  };
  await saveRun('Second flock'); await saveRun('Third flock'); await saveRun('Fourth flock');
  // Nendo reads records in record-ID order; the fixture keeps them as written, so they are put in
  // Nendo's order and read again before the list is measured.
  await reopened.evaluate(() => { for (const row of document.querySelectorAll('.experiment-row')) row.dataset.read = 'before'; });
  const byRecordId = await page.evaluate(() => window.broker.records('sw.experiment').sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)));
  const sameFile = Object.fromEntries(await Promise.all(['sw.species', 'sw.node', 'sw.link', 'sw.habitat'].map(async entityId => [entityId, await page.evaluate(id => window.broker.records(id), entityId)])));
  await page.evaluate(({ fixture, records }) => { window.broker.setFixture({ ...fixture, records }); window.broker.pushChanges(); }, { fixture: swarmFixture, records: { ...sameFile, 'sw.experiment': byRecordId } });
  await reopened.waitForFunction(() => document.querySelectorAll('.experiment-row').length === 4 && !document.querySelector('.experiment-row[data-read]'), null, { timeout: 8000 })
    .catch(async () => { throw Error('The experiments were not read again in record-ID order: ' + JSON.stringify(await reopened.evaluate(() => ({ rows: document.querySelectorAll('.experiment-row').length, status: document.getElementById('status').textContent })))); });
  const listed = await reopened.evaluate(() => [...document.querySelectorAll('.experiment-copy')].map(row => row.firstChild.textContent));
  assert(JSON.stringify(listed) === JSON.stringify(['Fourth flock', 'Third flock', 'Second flock', 'First flock']), `Saved experiments are not listed newest first: ${JSON.stringify(listed)}`);
  // A second Replay pressed while one runs is ignored; two ran at once and the last to finish won.
  await reopened.evaluate(() => {
    window.__replayed = [];
    new MutationObserver(() => { const text = document.getElementById('status').textContent; if (/^Replayed /.test(text)) window.__replayed.push(text); })
      .observe(document.getElementById('status'), { childList: true, characterData: true, subtree: true });
    const [first, second] = document.querySelectorAll('.experiment-row button');
    first.click(); second.click();
  });
  // Settled once no replay runs: a second one, had it started, has finished too.
  await reopened.waitForFunction(() => window.__replayed.length > 0 && window.swarm.replaying === 0, null, { timeout: 8000 });
  const replays = await reopened.evaluate(() => ({ said: window.__replayed, now: document.getElementById('status').textContent }));
  assert(replays.said.length === 1 && /^Replayed “Fourth flock”/.test(replays.now), `Two Replays pressed one after the other both ran, and the last to finish won: ${JSON.stringify(replays)}`);
  await reopened.getByRole('button', { name: 'Reload saved' }).click(); await reopened.waitForFunction(() => document.querySelector('#run-state').textContent === 'Paused' && !window.swarm.dirty);
  // A change made while a save is on its way stays a draft; it was called saved and lost.
  const heldSpecies = await reopened.evaluate(() => window.swarm.model.species.id);
  await reopened.getByLabel('Speed', { exact: true }).fill('2.2'); await reopened.getByLabel('Speed', { exact: true }).dispatchEvent('change');
  const heldBefore = await batches();
  // The save's own changes event comes after the save is done, as Nendo's broker may hold one back.
  const eventsBefore = await page.evaluate(() => window.broker.events.length);
  await page.evaluate(() => { window.broker.hold('records.batch', 900); window.broker.delayChanges(1500); });
  await command('save-behaviour');
  await page.waitForFunction(count => window.broker.requests.filter(request => request.m === 'records.batch').length > count, heldBefore);
  await reopened.getByLabel('Population', { exact: true }).fill('300'); await reopened.getByLabel('Population', { exact: true }).dispatchEvent('change');
  await reopened.waitForFunction(() => !window.swarm.saving, null, { timeout: 8000 });
  const meanwhile = await reopened.evaluate(() => ({ dirty: window.swarm.dirty, population: window.swarm.model.species.population, state: document.getElementById('draft-state').textContent,
    kept: Object.keys(localStorage).some(key => key.startsWith('swarm.draft.v1.')), status: document.getElementById('status').textContent }));
  const heldStored = (await record('sw.species', heldSpecies)).values;
  assert(heldStored['sw.species.speed'] === 2.2 && heldStored['sw.species.population'] !== 300, `The held save did not write what it was sent with: ${JSON.stringify(heldStored)}`);
  assert(meanwhile.dirty && meanwhile.population === 300 && meanwhile.kept && meanwhile.state === 'Unsaved behaviour',
    `A change made while the save was on its way was called saved, and its draft dropped: ${JSON.stringify(meanwhile)}`);
  // The late changes event is the view's own save: the draft can still be saved, not refused as changed elsewhere.
  await page.waitForFunction(start => window.broker.events.slice(start).some(event => event.n === 'changes'), eventsBefore, { timeout: 8000 });
  const secondBefore = await batches();
  await command('save-behaviour');
  await page.waitForFunction(count => window.broker.requests.filter(request => request.m === 'records.batch').length > count, secondBefore, { timeout: 3000 }).catch(() => undefined);
  const second = { batches: (await batches()) - secondBefore, stored: (await record('sw.species', heldSpecies)).values['sw.species.population'],
    problem: await reopened.evaluate(() => document.getElementById('problem').hidden ? null : document.getElementById('problem').textContent),
    status: await reopened.evaluate(() => document.getElementById('status').textContent) };
  assert(second.batches === 1, `The save's own late changes event was taken for somebody else's, and the draft could not be saved: ${JSON.stringify(second)}`);
  await reopened.waitForFunction(() => !window.swarm.saving && !window.swarm.dirty, null, { timeout: 8000 })
    .catch(async () => { throw Error('The second save did not finish as saved: ' + JSON.stringify(await reopened.evaluate(() => ({ dirty: window.swarm.dirty, saving: window.swarm.saving, status: document.getElementById('status').textContent, problem: document.getElementById('problem').textContent })))); });
  assert((await record('sw.species', heldSpecies)).values['sw.species.population'] === 300, 'The draft saved after a late changes event did not write its population.');
  await reopened.getByRole('button', { name: 'Reload saved' }).click(); await reopened.waitForFunction(() => !window.swarm.dirty && !window.swarm.saving);
  const colours = {};
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => window.broker.pushTheme(mode), mode); await page.waitForTimeout(100);
    colours[mode] = await reopened.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color,
      states: [...document.querySelectorAll('.dot')].map(e => getComputedStyle(e).backgroundColor),
      expected: ['cobalt', 'healthy', 'warning', 'danger', 'tone-violet'].map(token => { const e = document.createElement('i'); e.style.color = `var(--nendo-${token})`; document.body.append(e); const colour = getComputedStyle(e).color; e.remove(); return colour; }) }));
    assert(new Set(colours[mode].states).size === 5, `${mode}: creature states do not have five distinct theme colours: ${JSON.stringify(colours[mode])}`);
    assert(JSON.stringify(colours[mode].states) === JSON.stringify(colours[mode].expected), `${mode}: the state legend kept colours from the previous theme.`);
    // A decision's label is edited in a box bpmn-js makes white; its text must show in both themes.
    await reopened.locator('[data-element-id="sw_murmuration_danger"] > .djs-hit').dblclick();
    await reopened.waitForFunction(() => document.activeElement?.classList.contains('djs-direct-editing-content'), null, { timeout: 5000 });
    const label = await reopened.evaluate(() => { const box = getComputedStyle(document.querySelector('.djs-direct-editing-parent')); return { color: box.color, background: box.backgroundColor }; });
    await page.keyboard.press('Escape');
    await reopened.waitForFunction(() => !document.activeElement?.classList.contains('djs-direct-editing-content'));
    const luminance = colour => {
      const [r, g, b] = colour.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [lighter, darker] = [luminance(label.color), luminance(label.background)].sort((a, b) => b - a);
    label.contrast = Math.round((lighter + 0.05) / (darker + 0.05) * 100) / 100;
    colours[mode].label = label;
    assert(label.contrast >= 4.5, `${mode}: a decision's label is edited as ${label.color} on ${label.background} (contrast ${label.contrast}), so the text cannot be read.`);
    assert(!(await reopened.evaluate(() => window.swarm.dirty)), 'Escape from a label edit changed the behaviour.');
    await page.screenshot({ path: '__OUTPUT__/' + mode + '.png', fullPage: true });
  }
  assert(colours.light.background !== colours.dark.background && colours.light.ink !== colours.dark.ink, 'Effective theme did not change the frame.');
  await page.setViewportSize({ width: 620, height: 1000 }); await page.waitForTimeout(100);
  const narrow = await reopened.evaluate(() => { const a = document.querySelector('#habitat').getBoundingClientRect(), b = document.querySelector('#diagram').getBoundingClientRect(); return { habitatBottom: a.bottom, diagramTop: b.top, width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }; });
  assert(narrow.diagramTop > narrow.habitatBottom && narrow.overflow <= 1, `Narrow panes must stack without overflow: ${JSON.stringify(narrow)}`);
  await page.screenshot({ path: '__OUTPUT__/narrow.png', fullPage: true });
  // A transition to a node of another species, and one whose Route points do not read, leave
  // the species loadable; each is named, and a save leaves the first as it is.
  const held = await page.evaluate(() => ({ links: window.broker.records('sw.link'), nodes: window.broker.records('sw.node') }));
  const ownLinks = held.links.filter(link => link.values['sw.link.species'] === 'sw_species_murmuration');
  const otherNode = held.nodes.find(node => node.values['sw.node.species'] === 'sw_species_fireflies');
  const crossing = { entityId: 'sw.link', recordId: 'sw_w213_crossing', version: 1, values: { ...ownLinks[0].values, 'sw.link.name': 'Crossing', 'sw.link.target': otherNode.recordId, 'sw.link.waypoints': null } };
  const unreadable = { ...ownLinks[1], version: ownLinks[1].version + 1, values: { ...ownLinks[1].values, 'sw.link.waypoints': '[{' } };
  await page.evaluate(({ crossing, unreadable }) => { window.broker.put('sw.link', crossing); window.broker.put('sw.link', unreadable); window.broker.pushChanges(); }, { crossing, unreadable });
  await reopened.waitForFunction(() => document.getElementById('problem').textContent.includes('sw_w213_crossing'), null, { timeout: 8000 }).catch(() => undefined);
  const inconsistent = await reopened.evaluate(() => ({ problem: document.getElementById('problem').textContent, tick: window.swarm.tick ?? null, links: window.swarm.model?.links.map(link => link.id) ?? [] }));
  assert(inconsistent.tick === 0 && inconsistent.problem.includes('sw_w213_crossing') && inconsistent.problem.includes(unreadable.recordId) &&
    inconsistent.links.includes(unreadable.recordId) && !inconsistent.links.includes('sw_w213_crossing'),
    `A species with an inconsistent transition did not load, or did not name it: ${JSON.stringify(inconsistent)}`);
  await reopened.getByLabel('Speed', { exact: true }).fill('2.3'); await reopened.getByLabel('Speed', { exact: true }).dispatchEvent('change');
  await command('save-behaviour'); await reopened.waitForFunction(() => !window.swarm.dirty && !window.swarm.saving);
  assert(await record('sw.link', 'sw_w213_crossing') !== undefined, 'Saving the behaviour deleted a transition the diagram left out.');
  // A species name over 80 characters, and more than 64 species, still leave Nendo's toolbar.
  const refusalsBefore = (await page.evaluate(() => window.broker.chromeRefusals)).length;
  const own = (await page.evaluate(() => window.broker.records('sw.species'))).find(species => species.recordId === 'sw_species_murmuration');
  // A bird where the 80-character cut falls: two UTF-16 units that must not be split.
  const longName = 'A murmuration of starlings over the reed beds at dusk, turning as one and then '.slice(0, 78) + '\u{1F426} breaking apart again';
  await page.evaluate(({ own, longName }) => {
    window.broker.put('sw.species', { ...own, version: own.version + 1, values: { ...own.values, 'sw.species.name': longName } });
    for (let i = 0; i < 70; i++) window.broker.put('sw.species', { entityId: 'sw.species', recordId: `sw_species_w213_${String(i).padStart(2, '0')}`, version: 1, values: { ...own.values, 'sw.species.name': `Extra ${i}` } });
    window.broker.pushChanges();
  }, { own, longName });
  await reopened.waitForFunction(name => window.swarm.model?.species.name === name, longName, { timeout: 8000 });
  let speciesSelect = null;
  for (let i = 0; i < 60 && speciesSelect === null; i++) {
    await page.waitForTimeout(50);
    const state = await page.evaluate(() => ({ refusals: window.broker.chromeRefusals, select: window.broker.toolbars.at(-1)?.items.find(item => item.id === 'species') }));
    if (state.refusals.length > refusalsBefore) assert(false, `Nendo refused Swarm's toolbar over a species name of ${longName.length} characters and 73 species, so Play, Reset and Save were gone: ${JSON.stringify(state.refusals.at(-1))}`);
    if (state.select?.options.some(option => option.value === 'sw_species_murmuration' && option.label.endsWith('…'))) speciesSelect = state.select;
  }
  assert(speciesSelect !== null && speciesSelect.options.length <= 64 && speciesSelect.options.every(option => option.label.length <= 80 && option.label.isWellFormed()),
    `Swarm declared a species select Nendo refuses, or cut a name inside a character: ${JSON.stringify(speciesSelect && { count: speciesSelect.options.length, longest: Math.max(...speciesSelect.options.map(option => option.label.length)),
      split: speciesSelect.options.filter(option => !option.label.isWellFormed()).map(option => option.value) })}`);
  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, opened, narrow, colours, pausedStep: paused, checks: ['paused opening', 'geometry', 'play/pause', 'disturbance', 'graph changes motion', 'one-batch save', 'captured replay', 'refused save retains draft', 'external change blocks overwrite', 'kept save not called unsaved', 'draft outlasts the view', 'add/connect/remove', 'invalid graph refusal', 'reopen', 'newest experiment first', 'one replay at a time', 'edit during a save stays a draft', 'label editor readable', 'Light/Dark', 'narrow layout', 'inconsistent transitions named', 'long species names and 73 species'], errors };
}
