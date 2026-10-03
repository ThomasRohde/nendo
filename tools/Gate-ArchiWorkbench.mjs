async (page) => {
  // The Archi workbench (extensions/archi, W-109) framed by the fixture broker as the Workbench
  // frames it, over Archisurance as Archi.nendo holds it (tools/archi/fixtures.mjs, which
  // Review-ArchiWorkbench.ps1 puts in place of the placeholder below). Record writes are offered,
  // records.batch included, so every gesture is measured by what reaches the fixture's records.
  const fixture = '__ARCHI_FIXTURE__';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto('__BROKER_URL__');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => window.broker.viewOrigin);
  await page.evaluate(() => { window.broker.offerWrites(true); window.broker.offerChrome(true); window.broker.offerPlaces(true); });
  await page.evaluate(value => window.broker.setFixture(value), fixture);

  let view = null;
  for (let attempt = 0; attempt < 200 && view === null; attempt += 1) {
    view = page.frames().find(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')) ?? null;
    if (view === null) await page.waitForTimeout(25);
  }
  assert(view !== null, 'The workbench never loaded from its own origin.');
  const status = () => view.evaluate(() => document.getElementById('status').textContent);
  const until = async (predicate, arg, message) => {
    try { await view.waitForFunction(predicate, arg, { timeout: 8000, polling: 50 }); } catch { throw new Error(message + ' The view says: ' + JSON.stringify(await status())); }
  };
  const records = entityId => page.evaluate(value => window.broker.records(value), entityId);
  const byName = async (entityId, name) => (await records(entityId)).find(record =>
    (record.values['ar.concept.name'] ?? record.values['ar.view.name'] ?? record.values['ar.folder.name']) === name);
  const rows = () => view.evaluate(() => [...document.querySelectorAll('#tree .row')].map(row => ({
    id: row.dataset.id, label: row.querySelector('.label')?.textContent.trim() ?? '', level: Number(row.getAttribute('aria-level')),
    selected: row.getAttribute('aria-selected') === 'true', expanded: row.getAttribute('aria-expanded'), tabindex: row.tabIndex,
  })));
  const selected = async () => (await rows()).find(row => row.selected) ?? null;
  const results = {};
  // W-112: the model as the fixture holds it, value for value, the batches the view has sent, and
  // one control of Nendo's row as the view last declared it.
  const modelNow = async () => JSON.stringify(await Promise.all(['ar.model', 'ar.folder', 'ar.concept', 'ar.view', 'ar.item', 'ar.property'].map(async entityId =>
    (await records(entityId)).map(record => [record.recordId, Object.entries(record.values).filter(([, value]) => value !== null).sort(([a], [b]) => (a < b ? -1 : 1))])
      .sort(([a], [b]) => (a < b ? -1 : 1)))));
  const batchCount = () => page.evaluate(() => window.broker.requests.filter(request => request.m === 'records.batch').length);
  const control = id => page.evaluate(wanted => {
    const find = items => { for (const item of items ?? []) { if (item.id === wanted) return item; const inner = find(item.items); if (inner) return inner; } return null; };
    return find(window.broker.toolbars.at(-1)?.items);
  }, id);
  /**
   * Undo or Redo pressed in Nendo's row, waited for: one batch more, and the status line saying
   * the step was done, which the view writes once it has read the model back and declared its row
   * again. Two steps can share a name, and a reread left over from the step before can declare the
   * row in between, so the line is cleared first and only the step's own sentence counts. Then
   * the other button names the step.
   */
  /** One of the row's controls carrying a label, waited for: the row is declared at most twenty times a second. */
  const labelIs = async (id, wanted, what) => {
    let now = null;
    for (let waited = 0; waited <= 3000; waited += 50) {
      now = (await control(id))?.label;
      if (now === wanted) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`${what}: the row offers ${JSON.stringify(now)}, not ${wanted}.`);
  };
  const rowQuiet = async () => {
    let count = -1, still = 0;
    for (let waited = 0; still < 8 && waited < 5000; waited += 50) {
      const now = await page.evaluate(() => window.broker.toolbars.length);
      still = now === count ? still + 1 : 0;
      count = now;
      await page.waitForTimeout(50);
    }
  };
  const step = async which => {
    const before = await batchCount();
    const pressed = await control(which);
    assert(pressed && !pressed.disabled, `${which} is not offered: ${JSON.stringify(pressed)}.`);
    const name = pressed.label.replace(/^(Undo|Redo) /, '');
    const other = which === 'undo' ? `Redo ${name}` : `Undo ${name}`;
    await view.evaluate(() => { document.getElementById('status').textContent = ''; });
    await page.evaluate(id => window.broker.command(id, null, 'toolbar'), which);
    for (let waited = 0; ; waited += 50) {
      if (await batchCount() === before + 1 && await status() === `${pressed.label}.`) break;
      if (waited > 8000) throw new Error(`${pressed.label} did not finish: ${await batchCount() - before} batches; the view says ${JSON.stringify(await status())}.`);
      await page.waitForTimeout(50);
    }
    // A view declares its row at most twenty times a second, so the row naming the step can land
    // a moment after the sentence; and two steps can share a name, so the row is read once no
    // declaration has come for a while, not as soon as a label matches.
    await rowQuiet();
    let now = null;
    for (let waited = 0; waited <= 3000; waited += 50) {
      now = (await control(which === 'undo' ? 'redo' : 'undo'))?.label;
      if (now === other.slice(0, 80)) break;
      await page.waitForTimeout(50);
    }
    assert(now === other.slice(0, 80), `After ${pressed.label} the row offers ${JSON.stringify(now)}, not ${other}; the view says ${JSON.stringify(await status())}.`);
    return name;
  };

  // ---- It reads the whole model, and names it in Nendo's row, with its controls there too.
  await until(() => /120 elements · 176 relationships · 17 views/.test(document.getElementById('status').textContent), null,
    'The workbench did not report Archisurance’s 120 elements, 176 relationships and 17 views.');
  const first = await rows();
  assert(first[0].label === 'Archisurance' && first[0].level === 1, `The tree does not start at the model: ${JSON.stringify(first[0])}.`);
  assert(first.slice(1).map(row => row.label).join('|') === 'Strategy|Business|Application|Technology & Physical|Motivation|Implementation & Migration|Other|Relations|Views',
    `The top-level folders are not Archi's nine in Archi's order: ${first.slice(1).map(row => row.label).join('|')}.`);
  const toolbar = await page.evaluate(() => window.broker.toolbars.at(-1));
  assert(toolbar && toolbar.items.some(item => item.id === 'find') && toolbar.add === 'new-element',
    `The workbench did not put Find and New in Nendo's row: ${JSON.stringify(toolbar)?.slice(0, 300)}.`);
  assert(await view.evaluate(() => getComputedStyle(document.getElementById('own-toolbar')).display === 'none'), 'The workbench drew its own toolbar beside Nendo’s.');
  results.read = { rows: first.length, toolbar: toolbar.items.map(item => item.id ?? item.kind) };

  // ---- W-117: the validator reports what archi-online reports for Archisurance (64 nested
  // elements and 8 duplicate names; tools/archi/validation-parity.json), and each issue opens
  // what it names: the object on its view, or the concept in the tree.
  assert(toolbar.items.some(item => item.id === 'validator' && item.kind === 'toggle'), 'Nendo’s row has no Validator toggle.');
  await page.evaluate(() => window.broker.command('validator', true, 'toolbar'));
  await until(() => document.querySelectorAll('#validator-list [data-issue]').length > 0, null, 'Opening the validator listed no issues.');
  const issues = () => view.evaluate(() => ({
    summary: document.getElementById('validator-summary').textContent,
    rows: [...document.querySelectorAll('#validator-list [data-issue]')].map(row => ({ index: Number(row.dataset.issue), rule: row.title,
      severity: row.closest('li').className, message: row.querySelector('.message').textContent })),
    headings: [...document.querySelectorAll('#validator-list h3, #validator-list h4')].map(h => h.textContent),
    stale: !document.querySelector('#validator-list .stale')?.hidden,
    height: document.getElementById('validator').getBoundingClientRect().height,
  }));
  const reported = await issues();
  const tally = rule => reported.rows.filter(row => row.rule === rule).length;
  assert(reported.summary === '0 errors, 8 warnings, 64 advice' && reported.rows.length === 72 && tally('nested-elements') === 64 && tally('duplicate-name') === 8,
    `The validator did not report archi-online's 72 issues for Archisurance: ${reported.summary}, ${reported.rows.length} rows.`);
  assert(reported.headings.join('|') === "Archi's checks (72)|Warnings (8)|Advice (64)", `The issues are not grouped by source and severity: ${reported.headings.join('|')}.`);
  assert(!reported.stale && reported.height >= 140, `The validator is ${reported.height} px high, or says it is stale when just run.`);
  // An issue on a view: HRM nested in the Organisation Structure View opens that view with HRM's box outlined where it is drawn.
  const hrm = reported.rows.find(row => row.message.startsWith("'HRM' is nested"));
  assert(hrm, 'No issue names HRM nested in its group.');
  const hrmBox = (await records('ar.item')).find(item => item.recordId === 'ar-3720');
  const absoluteAt = async id => {
    const items = await records('ar.item');
    let x = 0, y = 0;
    for (let at = items.find(item => item.recordId === id); at; at = items.find(item => item.recordId === at.values['ar.item.parent'])) { x += at.values['ar.item.x']; y += at.values['ar.item.y']; }
    return { x, y };
  };
  await view.click(`#validator-list [data-issue="${hrm.index}"]`);
  await until(id => document.querySelector('#tree .row[aria-selected="true"]')?.dataset.id === id, hrmBox.values['ar.item.concept'],
    'Choosing the HRM issue did not select HRM in the tree.');
  await until(() => document.querySelectorAll('.canvas-host .selection .selected-box').length === 1, null, 'Choosing the HRM issue outlined no box.');
  const outline = await view.evaluate(() => { const rect = document.querySelector('.canvas-host .selection .selected-box'); return { x: Number(rect.getAttribute('x')) + 2, y: Number(rect.getAttribute('y')) + 2 }; });
  const expectedAt = await absoluteAt('ar-3720');
  assert(outline.x === expectedAt.x && outline.y === expectedAt.y, `The outline is at ${JSON.stringify(outline)}, not at HRM's box in the Organisation Structure View, ${JSON.stringify(expectedAt)}.`);
  const openedName = await view.evaluate(() => document.querySelector('.canvas-host svg.stage')?.getAttribute('aria-label'));
  assert(openedName === 'The view Organisation Structure View', `The HRM issue opened ${openedName}.`);
  const marked = await view.evaluate(index => {
    const probe = value => { const span = document.createElement('span'); span.style.color = value; document.body.append(span); const c = getComputedStyle(span).color; span.remove(); return c; };
    const current = [...document.querySelectorAll('#validator-list [aria-current="true"]')];
    return { rows: current.map(row => Number(row.dataset.issue)), background: current[0] ? getComputedStyle(current[0]).backgroundColor : null, expect: probe('var(--nendo-cobalt-soft)') };
  }, hrm.index);
  assert(marked.rows.length === 1 && marked.rows[0] === hrm.index && marked.background === marked.expect, `The HRM issue is not the one marked as opened: ${JSON.stringify(marked)}.`);
  // An issue on a concept: a duplicate name selects that element in the tree, and the view stays open.
  const duplicate = reported.rows.find(row => row.rule === 'duplicate-name');
  const duplicateName = /^The name '(.*)' is used more than once/.exec(duplicate.message)[1];
  await view.click(`#validator-list [data-issue="${duplicate.index}"]`);
  await until(name => document.querySelector('#tree .row[aria-selected="true"] .label')?.textContent === name, duplicateName,
    `Choosing a duplicate-name issue did not select ${duplicateName} in the tree.`);
  // Rules: turning Nested elements off leaves the eight duplicate names, and turning it on brings the 64 back.
  const setRule = async (rule, on) => {
    await view.click('#validator-rules');
    await until(() => document.getElementById('validator-config').open, null, 'Rules… did not open its dialog.');
    const boxes = await view.evaluate(() => [...document.querySelectorAll('#validator-config-list input')].map(box => box.dataset.rule));
    assert(boxes.length === 8, `The rules dialog offers ${boxes.length} rules, not Archi's eight.`);
    await view.evaluate(([id, value]) => { document.querySelector(`#validator-config-list input[data-rule="${id}"]`).checked = value; }, [rule, on]);
    await view.click('#validator-config button[value="done"]');
  };
  await setRule('nested-elements', false);
  await until(() => document.querySelectorAll('#validator-list [data-issue]').length === 8, null, 'Turning Nested elements off did not leave the eight duplicate names.');
  await setRule('nested-elements', true);
  await until(() => document.querySelectorAll('#validator-list [data-issue]').length === 72, null, 'Turning Nested elements on did not bring its 64 issues back.');
  // A change to the file says the list is of an earlier model, until Validate is pressed again.
  await page.evaluate(() => { window.broker.touch('ar.model', 'ar.model.r.model'); window.broker.pushChanges(); });
  await until(() => document.querySelector('#validator-list .stale')?.hidden === false, null, 'A change to the file did not mark the issues as of an earlier model.');
  await view.click('#validate');
  await until(() => document.querySelector('#validator-list .stale')?.hidden === true, null, 'Validate did not check the model as it now is.');
  // Both themes: the panel is Nendo's surface, its rows Nendo's ink.
  const validatorThemes = {};
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.broker.pushTheme(value), mode);
    await until(value => document.documentElement.dataset.nendoTheme === value, mode, `The ${mode} theme did not reach the page.`);
    validatorThemes[mode] = await view.evaluate(() => {
      const probe = value => { const span = document.createElement('span'); span.style.color = value; document.body.append(span); const c = getComputedStyle(span).color; span.remove(); return c; };
      return { panel: getComputedStyle(document.getElementById('validator')).backgroundColor, row: getComputedStyle(document.querySelector('#validator-list [data-issue]')).color,
        surface: probe('var(--nendo-surface)'), ink: probe('var(--nendo-ink)') };
    });
    const c = validatorThemes[mode];
    assert(c.panel === c.surface && c.row === c.ink, `In the ${mode} theme the validator is not Nendo's surface and ink: ${JSON.stringify(c)}.`);
    await page.screenshot({ path: `archi-validator-${mode}.png` });
  }
  await page.evaluate(() => window.broker.command('validator', false, 'toolbar'));
  await until(() => document.getElementById('validator').hidden, null, 'Closing the validator did not hide it.');
  await page.evaluate(() => window.broker.pushPlace({ view: null, selected: 'ar.model.r.model', item: null }));
  await until(() => !document.querySelector('.canvas-host') && document.querySelector('#tree .row[aria-selected="true"]')?.dataset.id === 'ar.model.r.model', null,
    'The workbench did not go back to the model after the validator steps.');
  // The jumps opened the folders on the way; closed again, the tree is as the steps below expect it.
  for (let open; (open = await view.evaluate(() => [...document.querySelectorAll('#tree .row[aria-expanded="true"]')].at(-1)?.dataset.id)) && open !== 'ar.model.r.model';) {
    await view.click(`#tree .row[data-id="${open}"] .twisty`);
  }
  // The views the jumps opened are places of their own; the Back and Forward steps below start after them.
  const placesBeforeViews = await page.evaluate(() => window.broker.places.length);
  results.validator = { issues: reported.rows.length, summary: reported.summary, hrm: outline, duplicate: duplicateName, themes: validatorThemes };

  // ---- The keyboard alone: one tab stop, arrows move and open, Enter reaches the properties.
  await view.focus('#tree .row[tabindex="0"]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert((await selected())?.label === 'Business', `Two presses of Down did not reach Business: ${JSON.stringify(await selected())}.`);
  await page.keyboard.press('ArrowRight');
  assert((await selected())?.expanded === 'true', 'Right did not open Business.');
  await page.keyboard.press('ArrowRight');
  const child = await selected();
  assert(child.level === 3, `Right on an open folder did not move to its first child: ${JSON.stringify(child)}.`);
  await page.keyboard.press('ArrowLeft');
  assert((await selected())?.label === 'Business', 'Left did not go back to the parent folder.');
  const stops = (await rows()).filter(row => row.tabindex === 0).length;
  assert(stops === 1, `The tree has ${stops} tab stops, not one.`);
  assert(await view.evaluate(() => document.activeElement?.closest('#tree') !== null), 'Focus left the tree while moving in it.');
  results.keyboard = { stops };

  // ---- Find narrows the tree to what matches and the folders on the way.
  await page.evaluate(() => window.broker.command('find', 'customer', 'toolbar'));
  await until(() => [...document.querySelectorAll('#tree .row .label')].some(label => /customer/i.test(label.textContent)), null, 'Find did not open the tree onto a match.');
  const found = (await rows()).filter(row => !['Archisurance'].includes(row.label));
  const leaves = [];
  for (const row of found) {
    const record = (await records('ar.concept')).find(candidate => candidate.recordId === row.id) ?? (await records('ar.view')).find(candidate => candidate.recordId === row.id);
    if (record) leaves.push(row);
  }
  assert(leaves.length > 0 && leaves.every(row => row.label.toLowerCase().includes('customer')), `Find kept something that does not match: ${leaves.map(row => row.label).join(', ')}.`);
  results.find = { matches: leaves.length };
  await page.evaluate(() => window.broker.command('find', '', 'toolbar'));

  // ---- Linked selection: a concept's views are listed in the middle, and one selects the view everywhere.
  const customer = await byName('ar.concept', 'Customer');
  assert(customer, 'Archisurance has no Customer.');
  await page.evaluate(() => window.broker.command('find', 'Customer', 'toolbar'));
  await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), customer.recordId, 'Customer is not in the tree under Find.');
  await view.click(`#tree .row[data-id="${customer.recordId}"]`);
  await until(() => /In views \(\d+\)/.test(document.getElementById('centre').textContent), null, 'The middle does not list Customer’s views.');
  const viewButton = await view.evaluate(() => [...document.querySelectorAll('#centre h3')].find(h => h.textContent.startsWith('In views'))?.nextElementSibling?.querySelector('button')?.dataset.select);
  await page.evaluate(() => window.broker.command('find', '', 'toolbar'));
  await view.click(`#centre [data-select="${viewButton}"]`);
  await until(id => document.querySelector('#tree .row[aria-selected="true"]')?.dataset.id === id, viewButton, 'Choosing a view in the middle did not select it in the tree.');
  const viewName = (await records('ar.view')).find(record => record.recordId === viewButton).values['ar.view.name'];
  assert(await view.evaluate(name => document.querySelector('#properties h2')?.textContent === name, viewName), 'The properties do not show the view the tree selected.');
  results.linked = { view: viewName };
  // R02-003: the actual helper's list must name every concept visible in this view.
  const expectedAlternative = (await records('ar.item')).filter(item => item.values['ar.item.view'] === viewButton && item.values['ar.item.kind'] === 'Element')
    .map(item => item.values['ar.item.concept']);
  const conceptNames = new Map((await records('ar.concept')).map(record => [record.recordId, record.values['ar.concept.name']]));
  const namedAlternative = expectedAlternative.map(id => conceptNames.get(id)).filter(Boolean);
  await until(count => document.querySelectorAll('.diagram-alternative li').length >= count, namedAlternative.length, 'The diagram text alternative never loaded.');
  const alternativeText = await view.locator('.diagram-alternative li').allTextContents();
  assert(namedAlternative.length > 0 && namedAlternative.every(name => alternativeText.includes(name)) && alternativeText.every(name => name.length > 0),
    'R02-003 the diagram text alternative lost its concept names: ' + JSON.stringify({ expected: namedAlternative, actual: alternativeText }));
  // The lists in a concept's Analysis read as rows that go to a record, not as bulleted buttons.
  await page.evaluate(() => window.broker.command('find', 'Customer', 'toolbar'));
  await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), customer.recordId, 'Customer is not in the tree under Find.');
  await view.click(`#tree .row[data-id="${customer.recordId}"]`);
  await until(() => !!document.querySelector('#properties ul.links button'), null, 'Customer’s properties show no Analysis list.');
  const lists = await view.evaluate(() => {
    const list = document.querySelector('#properties ul.links');
    const button = list?.querySelector('button');
    if (!list || !button) return { missing: true };
    const l = getComputedStyle(list), b = getComputedStyle(button);
    return { bullets: l.listStyleType, background: b.backgroundColor, border: b.borderTopWidth, align: b.textAlign };
  });
  assert(!lists.missing && lists.bullets === 'none' && lists.background === 'rgba(0, 0, 0, 0)' && lists.border === '0px' && lists.align === 'left',
    `A concept's Analysis lists are drawn as bulleted buttons: ${JSON.stringify(lists)}.`);
  results.lists = lists;
  await page.evaluate(() => window.broker.command('find', '', 'toolbar'));

  const beforeTreeGestures = { model: await modelNow(), batches: await batchCount() };
  // ---- F2 renames in the tree; the properties write a field; the property list writes records.
  await view.click(`#tree .row[data-id="${customer.recordId}"]`).catch(async () => {
    await page.evaluate(() => window.broker.command('find', 'Customer', 'toolbar'));
    await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), customer.recordId, 'Customer did not come back under Find.');
    await view.click(`#tree .row[data-id="${customer.recordId}"]`);
  });
  await page.keyboard.press('F2');
  await until(() => !!document.querySelector('#tree input.rename'), null, 'F2 did not start a rename.');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Policyholder');
  await page.keyboard.press('Enter');
  await until(() => document.getElementById('status').textContent.startsWith('Rename'), null, 'The rename was not written.');
  assert((await byName('ar.concept', 'Policyholder'))?.recordId === customer.recordId, 'The fixture does not hold Customer renamed to Policyholder.');
  await view.fill('#properties textarea[data-field="ar.concept.documentation"]', 'Anyone who buys insurance.');
  await view.dispatchEvent('#properties textarea[data-field="ar.concept.documentation"]', 'change');
  await until(() => document.getElementById('status').textContent.startsWith('Change Policyholder'), null, 'The documentation was not written.');
  assert((await byName('ar.concept', 'Policyholder')).values['ar.concept.documentation'] === 'Anyone who buys insurance.', 'The documentation did not reach the record.');
  await view.click('#properties [data-prop-action="add"]');
  await view.fill('#properties tr[data-index="0"] input[data-prop="value"]', 'Sales');
  await view.fill('#properties tr[data-index="0"] input[data-prop="key"]', 'owner');
  await view.dispatchEvent('#properties tr[data-index="0"] input[data-prop="key"]', 'change');
  await until(() => document.getElementById('status').textContent.startsWith('Change the properties'), null, 'The property was not written.');
  const property = (await records('ar.property')).find(record => record.values['ar.property.concept'] === customer.recordId);
  assert(property?.values['ar.property.key'] === 'owner' && property.values['ar.property.value'] === 'Sales', `The property record is not owner = Sales on Policyholder: ${JSON.stringify(property)}; the file holds ${JSON.stringify(await records('ar.property'))}; the view says ${JSON.stringify(await status())}.`);
  results.edit = { renamed: 'Policyholder', property: property.recordId };
  // Two edits in the same moment (F-211): the second was planned against the version the first
  // had already moved on, and refused as a changed target. Both must land.
  // Settle first: leave the fields, and wait until the last edit's write and reread are done.
  await view.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(400);
  await view.click('#properties [data-prop-action="add"]');
  await until(() => !!document.querySelector('#properties tr[data-index="1"] input[data-prop="key"]'), null, 'Add property made no second row.');
  await view.evaluate(() => {
    const documentation = document.querySelector('#properties textarea[data-field="ar.concept.documentation"]');
    documentation.value = 'Anyone who buys a policy.';
    documentation.dispatchEvent(new Event('change', { bubbles: true }));
    const key = document.querySelector('#properties tr[data-index="1"] input[data-prop="key"]');
    key.value = 'region';
    key.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Both land, whatever order the reads come back in: poll the file, not the status line.
  let quick, quickKeys = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    quick = await byName('ar.concept', 'Policyholder');
    quickKeys = (await records('ar.property')).filter(record => record.values['ar.property.concept'] === customer.recordId).map(record => record.values['ar.property.key']).sort();
    if (quick.values['ar.concept.documentation'] === 'Anyone who buys a policy.' && quickKeys.join() === 'owner,region') break;
    await page.waitForTimeout(100);
  }
  assert(quick.values['ar.concept.documentation'] === 'Anyone who buys a policy.' && quickKeys.join() === 'owner,region',
    `Two quick edits did not both land: ${JSON.stringify({ documentation: quick.values['ar.concept.documentation'], keys: quickKeys, status: await status() })}.`);

  // ---- A new element goes to its layer's folder, through Nendo's Add.
  const beforeCount = (await records('ar.concept')).length;
  await page.evaluate(() => window.broker.command('new-element', null, 'add'));
  await until(() => document.getElementById('new-element').open, null, 'Add did not open the new-element dialog.');
  await view.selectOption('#new-element-type', 'ApplicationComponent');
  await view.fill('#new-element-name', 'Broker portal');
  await view.click('#new-element button[value="create"]');
  await until(() => document.getElementById('status').textContent.startsWith('Create Broker portal'), null, 'The element was not created.');
  const created = await byName('ar.concept', 'Broker portal');
  const folders = await records('ar.folder');
  const application = folders.find(folder => folder.values['ar.folder.kind'] === 'Application');
  let home = folders.find(folder => folder.recordId === created?.values['ar.concept.folder']);
  while (home?.values['ar.folder.parent']) home = folders.find(folder => folder.recordId === home.values['ar.folder.parent']);
  assert(created && home?.recordId === application.recordId && (await records('ar.concept')).length === beforeCount + 1,
    `The new Application Component is not in the Application tree: ${JSON.stringify(created?.values)}.`);
  assert((await selected())?.id === created.recordId, `The new element is not selected: ${JSON.stringify(await selected())}; the view says ${JSON.stringify(await status())}; Nendo refused ${JSON.stringify(await page.evaluate(() => window.broker.chromeRefusals))}.`);
  results.create = { recordId: created.recordId };

  // ---- A drag onto a folder of another layer is refused; onto a folder of its own layer it moves.
  const businessRoot = folders.find(folder => folder.values['ar.folder.kind'] === 'Business');
  const dragTo = (from, to) => view.evaluate(([fromId, toId]) => {
    const source = document.querySelector(`#tree .row[data-id="${fromId}"]`), target = document.querySelector(`#tree .row[data-id="${toId}"]`);
    const data = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data });
    target.dispatchEvent(over);
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
    return over.defaultPrevented;
  }, [from, to]);
  await view.click(`#tree .row[data-id="${application.recordId}"]`);
  const acceptedWrongLayer = await dragTo(created.recordId, businessRoot.recordId);
  assert(!acceptedWrongLayer, 'A drag of an Application Component over the Business folder was offered a drop.');
  const subfolder = folders.find(folder => folder.values['ar.folder.parent'] === application.recordId);
  if (!(await rows()).some(row => row.id === subfolder.recordId)) await view.click(`#tree .row[data-id="${application.recordId}"] .twisty`);
  const acceptedOwnLayer = await dragTo(created.recordId, subfolder.recordId);
  await until(() => document.getElementById('status').textContent.startsWith('Move Broker portal'), null, 'The drag onto an Application folder did not move it.');
  assert(acceptedOwnLayer && (await byName('ar.concept', 'Broker portal')).values['ar.concept.folder'] === subfolder.recordId, 'The element is not in the folder it was dropped on.');
  results.drag = { refusedAcrossLayers: true, moved: true };

  // ---- Deleting an element takes its relationships and its diagram objects, in one revision.
  const client = await byName('ar.concept', 'Policyholder');
  const relationships = (await records('ar.concept')).filter(record => record.values['ar.concept.source'] === client.recordId || record.values['ar.concept.target'] === client.recordId);
  const boxes = (await records('ar.item')).filter(record => record.values['ar.item.concept'] === client.recordId);
  const requestsBefore = await page.evaluate(() => window.broker.requests.filter(request => request.m === 'records.batch').length);
  await page.evaluate(() => window.broker.command('find', 'Policyholder', 'toolbar'));
  await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), client.recordId, 'Policyholder is not in the tree under Find.');
  await view.click(`#tree .row[data-id="${client.recordId}"]`);
  await page.keyboard.press('Delete');
  await until(() => document.getElementById('confirm-delete').open, null, 'Delete did not ask first.');
  const question = await view.evaluate(() => document.getElementById('confirm-delete-text').textContent);
  await view.click('#confirm-delete button[value="delete"]');
  await until(() => document.getElementById('status').textContent.startsWith('Delete Policyholder'), null, 'The delete was not written.');
  const after = await records('ar.concept');
  assert(!after.some(record => record.recordId === client.recordId) && relationships.every(r => !after.some(record => record.recordId === r.recordId)),
    'Policyholder or one of its relationships is still in the model.');
  const itemsAfter = await records('ar.item');
  assert(boxes.length > 0 && boxes.every(box => !itemsAfter.some(record => record.recordId === box.recordId)),
    'A diagram object that showed Policyholder is still there.');
  const batches = await page.evaluate(() => window.broker.requests.filter(request => request.m === 'records.batch').length);
  assert(batches === requestsBefore + 1, `The delete took ${batches - requestsBefore} batches, not one.`);
  results.delete = { question, relationships: relationships.length, boxes: boxes.length };

  // ---- W-112: Undo and Redo of what the file saved, from Nendo's row. Every gesture since the
  // rename -- a rename, a documentation, two property lists, a new element, a move and a delete
  // with its relationships and boxes -- walked back one revision each to the model as it was, value
  // for value, and forward again to the model as it is. Undo names what it undoes. Then an undo of
  // a record somebody else changed since is refused, says why, and writes nothing.
  {
    const afterGestures = { model: await modelNow(), batches: await batchCount() };
    const gestures = afterGestures.batches - beforeTreeGestures.batches;
    await labelIs('undo', 'Undo Delete Policyholder', 'Undo does not name the delete');
    const undone = [];
    for (let index = 0; index < gestures; index += 1) undone.push(await step('undo'));
    await page.waitForTimeout(300);
    assert(await modelNow() === beforeTreeGestures.model, `Undoing ${gestures} gestures (${undone.join(' | ')}) did not put the model back as it was.`);
    const redone = [];
    for (let index = 0; index < gestures; index += 1) redone.push(await step('redo'));
    await page.waitForTimeout(300);
    assert(await modelNow() === afterGestures.model, `Redoing ${gestures} gestures (${redone.join(' | ')}) did not make the model as it was after them.`);
    assert(JSON.stringify(redone) === JSON.stringify([...undone].reverse()), `Redo did not make the steps again in order: ${redone.join(' | ')}.`);

    // Somebody else changes what an undo would put back: refused, said, nothing written.
    const portal = await byName('ar.concept', 'Broker portal');
    await page.evaluate(() => window.broker.command('find', 'Broker portal', 'toolbar'));
    await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), portal.recordId, 'Broker portal is not in the tree under Find.');
    await view.click(`#tree .row[data-id="${portal.recordId}"]`);
    await page.keyboard.press('F2');
    await until(() => !!document.querySelector('#tree input.rename'), null, 'F2 did not start a rename of Broker portal.');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Partner portal');
    await page.keyboard.press('Enter');
    await until(() => document.getElementById('status').textContent === 'Rename Broker portal.', null, 'The rename of Broker portal was not written.');
    await page.evaluate(id => { window.broker.touch('ar.concept', id); window.broker.pushChanges(); }, portal.recordId);
    await page.waitForTimeout(400);
    const touched = { model: await modelNow(), batches: await batchCount() };
    await labelIs('undo', 'Undo Rename Broker portal', 'Undo does not name the rename');
    await page.evaluate(() => window.broker.command('undo', null, 'toolbar'));
    await until(() => document.getElementById('status').textContent === 'Undo Rename Broker portal was refused: Partner portal has changed since. Nothing was changed.',
      null, 'An undo of a record changed since did not say why it was refused.');
    assert(await modelNow() === touched.model && await batchCount() === touched.batches, 'A refused undo wrote something.');
    await page.evaluate(() => window.broker.command('find', '', 'toolbar'));
    results.undo = { gestures, undone, refused: 'Partner portal has changed since' };
  }
  await page.evaluate(() => window.broker.command('find', '', 'toolbar'));


  // ---- W-110: a view opens drawn in the middle, and the diagram and the tree select each other.
  const allViews = await records('ar.view');
  const itemsFirst = await records('ar.item');
  const elementsOn = id => itemsFirst.filter(item => item.values['ar.item.view'] === id && item.values['ar.item.kind'] === 'Element').length;
  const opened = [...allViews].sort((a, b) => elementsOn(b.recordId) - elementsOn(a.recordId))[0];
  const topLevel = (await records('ar.item')).filter(item => item.values['ar.item.view'] === opened.recordId && !item.values['ar.item.parent']
    && !/onnection/.test(item.values['ar.item.kind']))
    .sort((a, b) => (a.values['ar.item.order'] ?? 1e15) - (b.values['ar.item.order'] ?? 1e15) || (a.recordId < b.recordId ? -1 : 1));
  await page.evaluate(value => window.broker.command('find', value, 'toolbar'), opened.values['ar.view.name']);
  await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), opened.recordId, 'The view is not in the tree under Find.');
  await view.click(`#tree .row[data-id="${opened.recordId}"]`);
  await until(count => document.querySelector('.canvas-host g.content')?.children.length === count + 1, topLevel.length,
    `The view ${opened.values['ar.view.name']} was not drawn with its ${topLevel.length} top-level objects.`);
  const zoomed = await page.evaluate(() => window.broker.toolbars.at(-1).items.some(item => item.kind === 'group' && item.label === 'Zoom'));
  assert(zoomed, 'An open view did not put Zoom in Nendo\u2019s row.');
  // A real click on an element box selects its concept in the tree and outlines the box.
  // Where an object is on screen: its absolute bounds from the records, through the view's transform.
  const itemsNow = await records('ar.item');
  const absolute = id => {
    let item = itemsNow.find(candidate => candidate.recordId === id), x = 0, y = 0;
    const size = { width: item.values['ar.item.width'], height: item.values['ar.item.height'] };
    for (; item; item = itemsNow.find(candidate => candidate.recordId === item.values['ar.item.parent'])) { x += item.values['ar.item.x']; y += item.values['ar.item.y']; }
    return { x, y, ...size };
  };
  const onScreen = async (id, dx = 6) => {
    const b = absolute(id);
    const { stageBox, value } = await view.evaluate(() => ({ stageBox: document.querySelector('.canvas-host svg.stage').getBoundingClientRect().toJSON(),
      value: document.querySelector('.canvas-host g.viewport').getAttribute('transform') }));
    const [, tx, ty, scale] = /translate\(([-\d.e]+),([-\d.e]+)\) scale\(([\d.e]+)\)/.exec(value).map(Number);
    return { x: stageBox.x + tx + (b.x + dx) * scale, y: stageBox.y + ty + (b.y + b.height - 6) * scale };
  };
  // The deepest element box on the view: nothing drawn inside it can take the click.
  const target = itemsNow.filter(item => item.values['ar.item.view'] === opened.recordId && item.values['ar.item.kind'] === 'Element')
    .find(item => !itemsNow.some(child => child.values['ar.item.parent'] === item.recordId));
  assert(target, `The view ${opened.values['ar.view.name']} has no element box without boxes inside it.`);
  const frameBox = await (await view.frameElement()).boundingBox();
  const box = await onScreen(target.recordId);
  await page.mouse.click(frameBox.x + box.x, frameBox.y + box.y);
  await until(id => document.querySelector('#tree .row[aria-selected="true"]')?.dataset.id === id, target.values['ar.item.concept'],
    'A click on a box in the diagram did not select its concept in the tree.');
  assert(await view.evaluate(() => document.querySelectorAll('.canvas-host .selection .selected-box').length === 1), 'The clicked box is not outlined.');
  await page.screenshot({ path: 'archi-diagram-selected.png' });
  // No focus ring inside the drawing (the owner's "fat rectangle"): a click focused the content
  // group and the browser drew its own ring round the whole view. The outline is the selection.
  const rings = await view.evaluate(() => [...document.querySelectorAll('.canvas-host svg.stage, .canvas-host svg.stage *')]
    .map(el => [el.getAttribute('class') ?? el.tagName, getComputedStyle(el).outlineStyle]).filter(([, style]) => style !== 'none'));
  assert(rings.length === 0, `A click on the diagram left a focus ring in it: ${JSON.stringify(rings.slice(0, 3))}.`);
  // Zoom and fit move one transform; a drag on the paper pans and selects nothing.
  const transform = () => view.evaluate(() => document.querySelector('.canvas-host g.viewport').getAttribute('transform'));
  const scaleOf = value => Number(/scale\(([\d.]+)\)/.exec(value)[1]);
  const before = scaleOf(await transform());
  await page.evaluate(() => window.broker.command('zoom-in', null, 'toolbar'));
  await until(expected => Math.abs(Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.canvas-host g.viewport').getAttribute('transform'))[1]) - expected) < 0.001,
    Math.min(4, before * 1.25), 'Zoom in did not scale the view by a quarter.');
  await page.evaluate(() => window.broker.command('fit', null, 'toolbar'));
  await until(expected => Math.abs(Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.canvas-host g.viewport').getAttribute('transform'))[1]) - expected) < 0.001,
    before, 'Fit did not return to the fitted scale.');
  // Fit fills the pane, measured on the smallest Archisurance view, the one that sits small in a
  // large pane: the paper spans the pane's width or its height, and fits inside it.
  const extentOf = id => {
    const top = itemsFirst.filter(item => item.values['ar.item.view'] === id && !item.values['ar.item.parent'] && item.values['ar.item.width'] > 0);
    if (top.length === 0) return Infinity;
    const xs = top.flatMap(item => [item.values['ar.item.x'], item.values['ar.item.x'] + item.values['ar.item.width']]);
    const ys = top.flatMap(item => [item.values['ar.item.y'], item.values['ar.item.y'] + item.values['ar.item.height']]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };
  const smallest = [...allViews].sort((a, b) => extentOf(a.recordId) - extentOf(b.recordId))[0];
  await page.evaluate(value => window.broker.command('find', value, 'toolbar'), smallest.values['ar.view.name']);
  await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), smallest.recordId, 'The smallest view is not in the tree under Find.');
  await view.click(`#tree .row[data-id="${smallest.recordId}"]`);
  await until(() => !!document.querySelector('.canvas-host .paper'), null, 'The smallest view was not drawn.');
  await page.evaluate(() => window.broker.command('fit', null, 'toolbar'));
  await page.waitForTimeout(100);
  const fill = await view.evaluate(() => {
    const paper = document.querySelector('.canvas-host .paper').getBoundingClientRect(), pane = document.querySelector('.canvas-host svg.stage').getBoundingClientRect();
    return { paper: [paper.width, paper.height].map(Math.round), pane: [pane.width, pane.height].map(Math.round),
      inside: paper.left >= pane.left - 1 && paper.top >= pane.top - 1 && paper.right <= pane.right + 1 && paper.bottom <= pane.bottom + 1 };
  });
  assert(fill.inside && (Math.abs(fill.paper[0] - fill.pane[0]) <= 2 || Math.abs(fill.paper[1] - fill.pane[1]) <= 2),
    `Fit does not fill the pane: ${smallest.values['ar.view.name']} is ${fill.paper.join('×')} in a pane of ${fill.pane.join('×')}.`);
  results.fit = { view: smallest.values['ar.view.name'], ...fill };
  await page.evaluate(value => window.broker.command('find', value, 'toolbar'), opened.values['ar.view.name']);
  await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), opened.recordId, 'The view is not in the tree under Find.');
  await view.click(`#tree .row[data-id="${opened.recordId}"]`);
  await until(id => document.querySelector('#tree .row[aria-selected="true"]')?.dataset.id === id, opened.recordId, 'The first view did not open again.');
  const stage = await view.evaluate(() => { const r = document.querySelector('.canvas-host svg.stage').getBoundingClientRect(); return { x: r.x + 8, y: r.y + 8 }; });
  const selectedBefore = (await selected())?.id;
  const panFrom = await transform();
  await page.mouse.move(frameBox.x + stage.x, frameBox.y + stage.y);
  await page.mouse.down();
  await page.mouse.move(frameBox.x + stage.x + 60, frameBox.y + stage.y + 40, { steps: 6 });
  await page.mouse.up();
  assert((await transform()) !== panFrom, 'A drag on the paper did not pan.');
  assert((await selected())?.id === selectedBefore, 'A pan changed the selection.');
  // Selecting a concept in the tree outlines every box that shows it on the open view.
  const shownTwice = Object.entries((await records('ar.item')).filter(item => item.values['ar.item.view'] === opened.recordId && item.values['ar.item.kind'] === 'Element')
    .reduce((count, item) => ({ ...count, [item.values['ar.item.concept']]: (count[item.values['ar.item.concept']] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])[0];
  assert(shownTwice, `The view ${opened.values['ar.view.name']} shows no element.`);
  await view.click(`#properties [data-select]`).catch(() => undefined);
  await page.evaluate(value => window.broker.command('find', value, 'toolbar'), (await records('ar.concept')).find(r => r.recordId === shownTwice[0]).values['ar.concept.name']);
  await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), shownTwice[0], 'The concept is not in the tree under Find.');
  await view.click(`#tree .row[data-id="${shownTwice[0]}"]`);
  await until(count => document.querySelectorAll('.canvas-host .selection .selected-box').length === count, shownTwice[1],
    `Selecting a concept in the tree did not outline its ${shownTwice[1]} boxes on the open view.`);
  // A double-click on a view reference opens the view it names.
  const reference = itemsFirst.find(item => item.values['ar.item.refView']);
  if (reference) {
    const referring = allViews.find(record => record.recordId === reference.values['ar.item.view']);
    await page.evaluate(value => window.broker.command('find', value, 'toolbar'), referring.values['ar.view.name']);
    await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), referring.recordId, 'The referring view is not in the tree under Find.');
    await view.click(`#tree .row[data-id="${referring.recordId}"]`);
    await until(id => document.querySelector('#tree .row[aria-selected="true"]')?.dataset.id === id, referring.recordId, 'The referring view did not open.');
    {
      await page.evaluate(() => window.broker.command('fit', null, 'toolbar'));
      const point = await onScreen(reference.recordId);
      await page.mouse.dblclick(frameBox.x + point.x, frameBox.y + point.y);
      await until(id => document.querySelector('#tree .row[aria-selected="true"]')?.dataset.id === id, reference.values['ar.item.refView'],
        'A double-click on a view reference did not open the view it names.');
    }
  }
  await page.evaluate(() => window.broker.command('find', '', 'toolbar'));
  results.diagram = { view: opened.values['ar.view.name'], objects: topLevel.length, outlined: shownTwice[1], reference: Boolean(reference) };

  // Every declaration the workbench made so far was one Nendo draws.
  const refusals = await page.evaluate(() => window.broker.chromeRefusals);
  assert(refusals.length === 0, `Nendo's rules refused the workbench's controls: ${JSON.stringify(refusals)}.`);
  assert(await view.evaluate(() => getComputedStyle(document.getElementById('own-toolbar')).display === 'none'), 'The workbench fell back to its own toolbar.');

  // ---- W-127: the workbench's places in Nendo's Back and Forward (the owner's F-215). Opening
  // another view is a step; a selection corrects the step it was made on; Back hands a place back
  // as the event place, and a view started again finds it in its context. None of it echoes.
  const declared = await page.evaluate(() => window.broker.places.map(entry => ({ ...entry })));
  assert(declared.length > 0 && declared[0].replace === true, `The place the workbench starts at was not declared as a correction: ${JSON.stringify(declared[0])}.`);
  const stepTo = declared.findIndex((entry, at) => at >= placesBeforeViews && !entry.replace && entry.place.view === smallest.recordId);
  assert(stepTo > 0, `Opening a second view was not a step: ${JSON.stringify(declared.slice(0, 8))}.`);
  assert(declared[stepTo].label === smallest.values['ar.view.name'], `The step does not carry the view's name for the Back button: ${JSON.stringify(declared[stepTo])}.`);
  const leftAt = declared.slice(placesBeforeViews, stepTo).filter(entry => entry.place.view === opened.recordId).at(-1)?.place;
  assert(leftAt && leftAt.selected === target.values['ar.item.concept'] && leftAt.item === target.recordId,
    `The box selected on the first view was not in its step, so Back would lose it: ${JSON.stringify(leftAt)}.`);
  const showsPlace = ([viewId, itemId, count]) => document.querySelector('.canvas-host g.content')?.children.length === count + 1
    && document.querySelector('#tree .row[aria-selected="true"]') !== null
    && document.querySelectorAll('.canvas-host .selection .selected-box').length === (itemId ? 1 : 0)
    && document.querySelector('.canvas-host svg.stage')?.getAttribute('aria-label')?.length > 0;
  const quietAfter = async (what) => {
    const count = await page.evaluate(() => window.broker.places.length);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.broker.places.slice(0));
    assert(after.length === count || after.slice(count).every(entry => entry.replace),
      `${what} made a step of its own: ${JSON.stringify(after.slice(count))}.`);
    return after.slice(count);
  };
  await page.evaluate(place => window.broker.pushPlace(place), leftAt);
  await until(showsPlace, [opened.recordId, leftAt.item, topLevel.length], 'Back did not return the workbench to the first view with its box selected.');
  assert((await selected())?.id === leftAt.selected, `Back selected ${JSON.stringify(await selected())} rather than ${leftAt.selected}.`);
  const echoedBack = await quietAfter('Back');
  const forwardTo = declared[stepTo].place;
  await page.evaluate(place => window.broker.pushPlace(place), forwardTo);
  await until(id => document.querySelector('#tree .row[aria-selected="true"]')?.dataset.id === id && !!document.querySelector('.canvas-host .paper'),
    forwardTo.selected, 'Forward did not open the second view again.');
  await quietAfter('Forward');
  // Back from a record page: the workbench started again, from the place its context carries.
  await page.evaluate(place => { window.broker.startAt(place); window.broker.remount(); }, leftAt);
  view = null;
  for (let attempt = 0; attempt < 400 && view === null; attempt += 1) {
    const candidate = page.frames().filter(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')).at(-1);
    if (candidate && await candidate.evaluate(showsPlace, [opened.recordId, leftAt.item, topLevel.length]).catch(() => false)) view = candidate;
    else await page.waitForTimeout(25);
  }
  assert(view !== null, 'A workbench started again after Back did not open the view and the box it was left on.');
  const restarted = await quietAfter('Starting again');
  await page.evaluate(() => window.broker.startAt(null));
  results.places = { declared: declared.length, steps: declared.filter(entry => !entry.replace).length, echoedBack: echoedBack.length, restarted: restarted.length };

  // ---- W-111: Edit opens the view in archi-online's editor. Gestures collect as edits waiting to
  // be committed; Undo and Redo work on them; Commit writes the net difference as one revision;
  // Discard drops them; a refused commit keeps them; they survive the workbench starting again.
  {
  const batches = () => page.evaluate(() => window.broker.requests.filter(request => request.m === 'records.batch').map(request => request.p));
  const toolbarItem = id => page.evaluate(wanted => {
    const find = items => { for (const item of items ?? []) { if (item.id === wanted) return item; const inner = find(item.items); if (inner) return inner; } return null; };
    return find(window.broker.toolbars.at(-1)?.items);
  }, id);
  const pendingIs = async (count, what) => {
    try {
      await page.waitForFunction(expected => {
        const find = items => { for (const item of items ?? []) { if (item.id === 'commit') return item; const inner = find(item.items); if (inner) return inner; } return null; };
        const commit = find(window.broker.toolbars.at(-1)?.items);
        return commit && (expected === 0 ? commit.disabled === true : commit.label === `Commit ${expected}`);
      }, count, { timeout: 8000, polling: 50 });
    } catch { throw new Error(`${what}: Commit says ${JSON.stringify(await toolbarItem('commit'))}, not ${count} waiting.`); }
  };
  const editedView = opened;
  await page.evaluate(() => window.broker.command('edit', true, 'toolbar'));
  await until(() => document.querySelectorAll('.archi-editor [data-node-id]').length > 0 && document.querySelectorAll('.archi-palette .pal-btn').length > 50,
    null, 'Edit did not open the view in archi-online\u2019s editor with its palette.');
  await pendingIs(0, 'An editor with nothing done');
  // The whole drawing is in sight when Edit opens the view (the owner, W-114).
  const fitted = await view.waitForFunction(() => {
    const stage = document.querySelector('.archi-editor .view-svg')?.getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.archi-editor [data-node-id]')].map(node => node.getBoundingClientRect());
    if (!stage || boxes.length === 0) return null;
    const outside = boxes.filter(box => box.left < stage.left - 2 || box.top < stage.top - 2 || box.right > stage.right + 2 || box.bottom > stage.bottom + 2).length;
    return outside === 0 ? { boxes: boxes.length } : null;
  }, null, { timeout: 4000, polling: 50 }).then(handle => handle.jsonValue()).catch(async () => ({ outside: await view.evaluate(() => {
    const stage = document.querySelector('.archi-editor .view-svg').getBoundingClientRect();
    return [...document.querySelectorAll('.archi-editor [data-node-id]')].filter(node => { const box = node.getBoundingClientRect(); return box.right > stage.right + 2 || box.bottom > stage.bottom + 2 || box.left < stage.left - 2 || box.top < stage.top - 2; }).length;
  }) }));
  assert(fitted.boxes > 0, `Edit opened the view with ${fitted.outside} boxes out of sight.`);
  const editFrame = await (await view.frameElement()).boundingBox();
  const boxOf = id => view.evaluate(wanted => {
    const element = document.querySelector(`.archi-editor [data-node-id="${wanted}"]`);
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, id);
  const drag = async (from, dx, dy) => {
    await page.mouse.move(editFrame.x + from.x, editFrame.y + from.y);
    await page.mouse.down();
    await page.mouse.move(editFrame.x + from.x + dx / 2, editFrame.y + from.y + dy / 2, { steps: 4 });
    await page.mouse.move(editFrame.x + from.x + dx, editFrame.y + from.y + dy, { steps: 4 });
    await page.mouse.up();
  };
  // The owner's transparent menus: archi-online draws them into the page's body, outside the
  // editor, and there its colour variables were undefined. A right-click menu has a background.
  const menuBox = await boxOf(target.recordId);
  await page.mouse.click(editFrame.x + menuBox.x + 8, editFrame.y + menuBox.y + menuBox.height / 2, { button: 'right' });
  await until(() => !!document.querySelector('.ctx-menu'), null, 'A right-click on a box opened no menu.');
  const menuColours = await view.evaluate(() => {
    const raised = getComputedStyle(document.documentElement).getPropertyValue('--nendo-surface-raised').trim();
    const probe = document.createElement('div'); probe.style.background = raised; document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor; probe.remove();
    return { menu: getComputedStyle(document.querySelector('.ctx-menu')).backgroundColor, token,
      border: getComputedStyle(document.querySelector('.ctx-menu')).borderTopColor };
  });
  assert(menuColours.menu === menuColours.token && menuColours.border !== 'rgba(0, 0, 0, 0)',
    `The editor's menu is not drawn on Nendo's raised surface: ${JSON.stringify(menuColours)}.`);
  await page.keyboard.press('Escape');
  await until(() => !document.querySelector('.ctx-menu'), null, 'Escape left the menu open.');
  // The palette is as wide as it is dragged, and its buttons fill the width in columns.
  const paletteShape = () => view.evaluate(() => {
    const palette = document.querySelector('.archi-palette').getBoundingClientRect();
    const columns = new Set([...document.querySelectorAll('.archi-palette .pal-layer .pal-btn')].map(button => Math.round(button.getBoundingClientRect().left))).size;
    return { width: Math.round(palette.width), columns };
  });
  const narrow = await paletteShape();
  const splitter = await view.evaluate(() => { const r = document.querySelector('.archi-palette-splitter').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
  await page.mouse.move(editFrame.x + splitter.x, editFrame.y + splitter.y);
  await page.mouse.down();
  await page.mouse.move(editFrame.x + splitter.x + 120, editFrame.y + splitter.y, { steps: 6 });
  await page.mouse.up();
  const wide = await paletteShape();
  assert(Math.abs(wide.width - narrow.width - 120) <= 2 && wide.columns > narrow.columns,
    `Dragging the palette's edge 120 pixels did not widen it into more columns: ${JSON.stringify({ narrow, wide })}.`);
  await view.focus('.archi-palette-splitter');
  for (let step = 0; step < 5; step += 1) await page.keyboard.press('ArrowLeft');
  const stepped = await paletteShape();
  assert(stepped.width === wide.width - 140, `The arrow keys on the palette's edge did not narrow it by 28 pixels a press: ${JSON.stringify({ wide, stepped })}.`);
  const palette = { narrow, wide, stepped, menu: menuColours.menu };
  // The owner's white selection: the editor draws its outline, handles and a selected line in
  // colours its SVG names by variable, and undefined they drew white or not at all. Selecting a
  // box and then a relationship's line, every mark of the selection is Nendo's accent.
  const selectionMarks = () => view.evaluate(() => {
    const cobalt = getComputedStyle(document.documentElement).getPropertyValue('--nendo-cobalt').trim();
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    probe.setAttribute('stroke', cobalt);
    document.querySelector('.archi-editor .view-svg').append(probe);
    const token = getComputedStyle(probe).stroke; probe.remove();
    const marks = [...document.querySelectorAll('.archi-editor .view-svg [stroke="var(--canvas-selection)"]')];
    return { token, count: marks.length, strokes: [...new Set(marks.map(mark => getComputedStyle(mark).stroke))] };
  });
  const box = await boxOf(target.recordId);
  await page.mouse.click(editFrame.x + box.x + 8, editFrame.y + box.y + box.height / 2);
  await until(() => document.querySelectorAll('.archi-editor .view-svg [stroke="var(--canvas-selection)"]').length >= 4, null, 'Selecting a box drew no handles.');
  const boxMarks = await selectionMarks();
  assert(boxMarks.strokes.length === 1 && boxMarks.strokes[0] === boxMarks.token,
    `A selected box's handles are not drawn in Nendo's accent: ${JSON.stringify(boxMarks)}.`);
  const linePoint = await view.evaluate(() => {
    for (const group of document.querySelectorAll('.archi-editor [data-conn-id]')) {
      const line = group.querySelectorAll('path')[1];
      if (!line) continue;
      const length = line.getTotalLength();
      if (length < 80) continue;
      const at = line.getPointAtLength(length / 2), matrix = line.getScreenCTM();
      const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
      const hit = document.elementFromPoint(point.x, point.y)?.closest('[data-conn-id]');
      if (hit === group) return { id: group.getAttribute('data-conn-id'), x: point.x, y: point.y };
    }
    return null;
  });
  assert(linePoint, 'No relationship line on the view can be clicked at its middle.');
  await page.mouse.click(editFrame.x + linePoint.x, editFrame.y + linePoint.y);
  await until(id => document.querySelector(`.archi-editor [data-conn-id="${id}"] path:nth-of-type(2)`)?.getAttribute('stroke') === 'var(--canvas-selection)',
    linePoint.id, 'Clicking a relationship\u2019s line did not select it.');
  const lineMarks = await selectionMarks();
  assert(lineMarks.strokes.length === 1 && lineMarks.strokes[0] === lineMarks.token,
    `A selected relationship's line is not drawn in Nendo's accent: ${JSON.stringify(lineMarks)}.`);
  await page.keyboard.press('Escape');
  const storedItem = async id => (await records('ar.item')).find(record => record.recordId === id);
  const moving = target.recordId;
  const startedAt = await storedItem(moving);
  const before1 = await boxOf(moving);
  await drag({ x: before1.x + 8, y: before1.y + before1.height / 2 }, 60, 0);
  await pendingIs(1, 'One box dragged');
  const before2 = await boxOf(moving);
  await drag({ x: before2.x + 8, y: before2.y + before2.height / 2 }, 30, 0);
  await pendingIs(1, 'The same box dragged again: still one change waiting');
  await page.evaluate(() => window.broker.command('undo', null, 'toolbar'));
  await pendingIs(1, 'The second drag undone');
  await page.evaluate(() => window.broker.command('undo', null, 'toolbar'));
  await pendingIs(0, 'Both drags undone');
  await page.evaluate(() => window.broker.command('redo', null, 'toolbar'));
  await page.evaluate(() => window.broker.command('redo', null, 'toolbar'));
  await pendingIs(1, 'Both drags redone');
  const batchesBefore = (await batches()).length;
  await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
  await pendingIs(0, 'Committed');
  const committed = (await batches()).slice(batchesBefore);
  assert(committed.length === 1 && committed[0].writes.length === 1 && committed[0].writes[0].recordId === moving
    && Object.keys(committed[0].writes[0].values).every(field => field === 'ar.item.x' || field === 'ar.item.y'),
    `Two drags, an undo and a redo did not commit as one revision setting the box's place: ${JSON.stringify(committed).slice(0, 400)}.`);
  const movedTo = await storedItem(moving);
  assert(movedTo.values['ar.item.x'] > startedAt.values['ar.item.x'] + 60, `The box was not moved in the file: ${startedAt.values['ar.item.x']} to ${movedTo.values['ar.item.x']}.`);
  // W-112: once committed, the edits are one step of the file's. Undo puts the box back where it
  // started, in one revision, and Redo moves it again; nothing is left waiting either way.
  await labelIs('undo', 'Undo Commit 1 change to the view', 'Undo does not name the commit');
  await step('undo');
  await pendingIs(0, 'The commit undone');
  const backAt = await storedItem(moving);
  assert(backAt.values['ar.item.x'] === startedAt.values['ar.item.x'] && backAt.values['ar.item.y'] === startedAt.values['ar.item.y'],
    `Undo did not put the box back where it started: ${backAt.values['ar.item.x']},${backAt.values['ar.item.y']}.`);
  await step('redo');
  await pendingIs(0, 'The commit redone');
  const againAt = await storedItem(moving);
  assert(againAt.values['ar.item.x'] === movedTo.values['ar.item.x'] && againAt.values['ar.item.y'] === movedTo.values['ar.item.y'],
    `Redo did not move the box again: ${againAt.values['ar.item.x']},${againAt.values['ar.item.y']}.`);

  // A new element from the palette, and relationships only of the types archi-online allows.
  const nodeIds = () => view.evaluate(() => [...document.querySelectorAll('.archi-editor [data-node-id]')].map(element => element.getAttribute('data-node-id')));
  const idsBefore = new Set(await nodeIds());
  await view.click('.archi-palette .pal-el[data-palette-element="BusinessActor"]:not(.pal-specialized-el)');
  const stage = await view.evaluate(() => { const r = document.querySelector('.archi-editor .view-svg').getBoundingClientRect(); return { x: r.right - 90, y: r.top + 40 }; });
  await page.mouse.click(editFrame.x + stage.x, editFrame.y + stage.y);
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await pendingIs(2, 'A Business Actor placed from the palette: the element and its box');
  const actorBox = (await nodeIds()).find(id => !idsBefore.has(id));
  assert(actorBox?.startsWith('ar-id-'), `The new box is not named as a record: ${actorBox}.`);
  const targetConcept = (await records('ar.concept')).find(record => record.recordId === target.values['ar.item.concept']);
  const targetType = (await records('ar.type')).find(record => record.recordId === targetConcept.values['ar.concept.type']).values['ar.type.key'];
  const { allowed, labels } = await view.evaluate(async type => {
    const rules = await import('./canvas.js');
    return { allowed: rules.validRelationshipTypes('BusinessActor', type), labels: Object.fromEntries(rules.RELATIONSHIP_TYPES.map(entry => [entry.type, entry.label])) };
  }, targetType);
  const refused = Object.keys(labels).find(type => !allowed.includes(type) && type !== 'Junction');
  const permitted = allowed[0];
  assert(refused && permitted, `No refused and no allowed relationship from a Business Actor to a ${targetType}: ${allowed}.`);
  const connect = async type => {
    await view.click(`.archi-palette .pal-btn[title="${labels[type]}"]`);
    const from = await boxOf(actorBox), to = await boxOf(moving);
    await page.mouse.move(editFrame.x + from.x + from.width / 2, editFrame.y + from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(editFrame.x + to.x + 8, editFrame.y + to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
  };
  await connect(refused);
  await page.waitForTimeout(300);
  await pendingIs(2, `A ${refused} from a Business Actor to a ${targetType}, which archi-online does not allow, was drawn`);
  await connect(permitted);
  await pendingIs(4, `A ${permitted} from a Business Actor to a ${targetType}: the relationship and its line`);
  const beforeCreate = (await batches()).length;
  await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
  await pendingIs(0, 'The element and the relationship committed');
  const created = (await batches()).slice(beforeCreate);
  assert(created.length === 1 && created[0].writes.length === 4 && created[0].writes.every(write => write.op === 'create'),
    `The element, its box, the relationship and its line were not one revision of four creates: ${JSON.stringify(created).slice(0, 500)}.`);
  const relationship = (await records('ar.concept')).find(record => record.recordId === created[0].writes.find(write => write.entityId === 'ar.concept' && write.values['ar.concept.category'] === 'Relationship')?.recordId);
  assert(relationship?.values['ar.concept.type'] === `ar.type.r.${permitted}`, `The committed relationship is not the ${permitted} drawn: ${JSON.stringify(relationship?.values)}.`);

  // Resize, nest, a new bendpoint and a reconnected end, then one commit that carries all four.
  const lineId = created[0].writes.find(write => write.entityId === 'ar.item' && write.values['ar.item.kind'] === 'Relationship connection').recordId;
  const sized = await boxOf(moving);
  // Away from where the new line meets the box: a click there selects the line.
  await page.mouse.click(editFrame.x + sized.x + sized.width - 12, editFrame.y + sized.y + sized.height - 6);
  const corner = await view.evaluate(id => {
    const handle = document.querySelector(`.archi-editor [data-handle="se"][data-handle-node="${id}"]`);
    if (!handle) return null;
    const r = handle.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, moving);
  assert(corner, 'A selected box has no resize handle at its corner.');
  await drag(corner, 30, 20);
  await pendingIs(1, 'A box resized');
  // Nest the new actor in a group: dropped on an empty part of one, it becomes its child.
  const groups = (await records('ar.item')).filter(record => record.values['ar.item.view'] === editedView.recordId && record.values['ar.item.kind'] === 'Group');
  const drop = await view.evaluate(ids => {
    for (const id of ids) {
      const group = document.querySelector(`.archi-editor [data-node-id="${id}"]`);
      if (!group) continue;
      const r = group.getBoundingClientRect();
      for (let y = r.top + 30; y < r.bottom - 20; y += 10) for (let x = r.left + 30; x < r.right - 80; x += 10) {
        if (document.elementFromPoint(x, y)?.closest('[data-node-id]')?.getAttribute('data-node-id') === id) return { id, x, y };
      }
    }
    return null;
  }, groups.map(group => group.recordId));
  assert(drop, 'No group on the view has an empty place to drop a box in.');
  const actorNow = await boxOf(actorBox);
  const grab = { x: actorNow.x + actorNow.width / 2, y: actorNow.y + actorNow.height / 2 };
  await drag(grab, drop.x + 20 - grab.x, drop.y + 10 - grab.y);
  await pendingIs(2, 'The new actor dropped into a group');
  // A new bendpoint: select the new line, then drag from its middle.
  const middleOf = id => view.evaluate(wanted => {
    const line = document.querySelectorAll(`.archi-editor [data-conn-id="${wanted}"] path`)[1];
    if (!line) return null;
    const at = line.getPointAtLength(line.getTotalLength() / 2);
    const point = new DOMPoint(at.x, at.y).matrixTransform(line.getScreenCTM());
    return { x: point.x, y: point.y };
  }, id);
  const middle = await middleOf(lineId);
  assert(middle, 'The new relationship has no line on the view.');
  await page.mouse.click(editFrame.x + middle.x, editFrame.y + middle.y);
  await drag(middle, 0, 45);
  await pendingIs(3, 'A bendpoint added to the new line');
  // Reconnect the line's far end to another box its relationship may reach.
  const concepts = await records('ar.concept');
  const typeKeys = new Map((await records('ar.type')).map(record => [record.recordId, record.values['ar.type.key']]));
  const boxes = (await records('ar.item')).filter(record => record.values['ar.item.view'] === editedView.recordId && record.values['ar.item.kind'] === 'Element'
    && record.recordId !== moving);
  const reachable = await view.evaluate(async ({ candidates, relation }) => {
    const rules = await import('./canvas.js');
    return candidates.filter(candidate => rules.validRelationshipTypes('BusinessActor', candidate.type).includes(relation)).map(candidate => candidate.id);
  }, { candidates: boxes.map(box => ({ id: box.recordId, type: typeKeys.get(concepts.find(c => c.recordId === box.values['ar.item.concept'])?.values['ar.concept.type']) })), relation: permitted });
  let reconnected = null;
  for (const id of reachable) {
    const b = await boxOf(id);
    if (!b) continue;
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const clear = await view.evaluate(({ id: wanted, x, y }) => document.elementFromPoint(x, y)?.closest('[data-node-id]')?.getAttribute('data-node-id') === wanted, { id, ...at });
    if (clear) { reconnected = { id, ...at }; break; }
  }
  assert(reconnected, `No other box on the view may be the target of a ${permitted} from a Business Actor.`);
  const lineAgain = await middleOf(lineId);
  await page.mouse.click(editFrame.x + lineAgain.x + 4, editFrame.y + lineAgain.y);
  const end = await view.evaluate(id => {
    const handle = document.querySelector(`.archi-editor [data-connection-endpoint-handle="target"][data-connection-endpoint-id="${id}"]`);
    if (!handle) return null;
    const r = handle.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, lineId);
  assert(end, 'A selected line has no handle at its target end.');
  await drag(end, reconnected.x - end.x, reconnected.y - end.y);
  await pendingIs(4, 'The line\u2019s target reconnected: the line and its relationship');
  const beforeFour = (await batches()).length;
  await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
  await pendingIs(0, 'Resize, nest, bendpoint and reconnect committed');
  const four = (await batches()).slice(beforeFour);
  assert(four.length === 1, `Four gestures did not commit as one revision: ${four.length} batches.`);
  const itemsAfter = await records('ar.item');
  const itemOf = id => itemsAfter.find(record => record.recordId === id).values;
  assert(itemOf(moving)['ar.item.width'] !== movedTo.values['ar.item.width'] && itemOf(moving)['ar.item.height'] !== movedTo.values['ar.item.height'],
    `The resize did not reach the file: ${JSON.stringify(itemOf(moving))}.`);
  assert(itemOf(actorBox)['ar.item.parent'] === drop.id, `The actor was not nested in the group: ${itemOf(actorBox)['ar.item.parent']} rather than ${drop.id}.`);
  assert(JSON.parse(itemOf(lineId)['ar.item.bendpoints'] ?? '[]').length === 1, `The line has no bendpoint in the file: ${itemOf(lineId)['ar.item.bendpoints']}.`);
  assert(itemOf(lineId)['ar.item.target'] === reconnected.id, `The line's target is ${itemOf(lineId)['ar.item.target']}, not the box it was reconnected to.`);
  const relationAfter = (await records('ar.concept')).find(record => record.recordId === itemOf(lineId)['ar.item.concept']);
  assert(relationAfter.values['ar.concept.target'] === itemOf(reconnected.id)['ar.item.concept'],
    'Reconnecting the line did not move its relationship\u2019s target with it.');

  // The magic connector offers, from a Business Actor to the moved box, exactly the relationship
  // types archi-online's rules allow between those two types.
  await view.click('.archi-palette .pal-btn[title^="Magic connector"]');
  const from = await boxOf(actorBox), to = await boxOf(moving);
  await page.mouse.click(editFrame.x + from.x + from.width / 2, editFrame.y + from.y + from.height / 2);
  await page.mouse.click(editFrame.x + to.x + 8, editFrame.y + to.y + to.height / 2);
  await until(() => [...document.querySelectorAll('.ctx-menu .ctx-label')].some(label => label.textContent === 'Forward'), null,
    'The magic connector offered no Forward relationships between the two boxes.');
  const forwardAt = await view.evaluate(() => {
    const item = [...document.querySelectorAll('.ctx-menu .ctx-item')].find(entry => entry.querySelector('.ctx-label')?.textContent === 'Forward');
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(editFrame.x + forwardAt.x, editFrame.y + forwardAt.y);
  await until(() => document.querySelectorAll('.ctx-menu').length >= 2, null, 'Forward opened no list of relationship types.');
  const offered = await view.evaluate(() => [...document.querySelectorAll('.ctx-menu')[1].querySelectorAll(':scope > .ctx-item > .ctx-label, :scope .ctx-item > .ctx-label')]
    .map(label => label.textContent));
  const expected = allowed.map(type => labels[type]);
  const offeredTypes = [...new Set(offered)].filter(label => expected.includes(label) || Object.values(labels).includes(label));
  assert(JSON.stringify([...offeredTypes].sort()) === JSON.stringify([...expected].sort()),
    `The magic connector offers ${JSON.stringify(offeredTypes)} from a Business Actor to a ${targetType}; archi-online's rules allow ${JSON.stringify(expected)}.`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await view.click('.archi-palette .pal-btn[title^="Select"]');
  await pendingIs(0, 'The magic connector dismissed');
  const magic = { offered: offeredTypes.length };

  // Delete from the view, then Discard: the view is as stored again.
  const objectsStored = (await nodeIds()).length;
  // The validator checks what the editor shows, waiting edits included (W-117): the actor's only
  // box deleted from the view, and not committed, makes the actor unused; Discard makes it used again.
  const actorConcept = (await records('ar.concept')).find(record => record.recordId === itemOf(actorBox)['ar.item.concept']);
  const unusedActor = `'${actorConcept.values['ar.concept.name'] || 'Business Actor'}' is not used in a View`;
  const unusedCount = () => view.evaluate(message => [...document.querySelectorAll('#validator-list [data-issue] .message')].filter(m => m.textContent === message).length, unusedActor);
  await page.evaluate(() => window.broker.command('validator', true, 'toolbar'));
  await until(() => document.querySelectorAll('#validator-list [data-issue]').length > 0, null, 'The validator listed nothing while editing.');
  const unusedBefore = await unusedCount();
  const actorAt = await boxOf(actorBox);
  await page.mouse.click(editFrame.x + actorAt.x + actorAt.width / 2, editFrame.y + actorAt.y + actorAt.height / 2);
  await page.keyboard.press('Delete');
  await pendingIs(2, 'The new box deleted from the view: the box and the line drawn to it');
  await until(() => document.querySelector('#validator-list .stale')?.hidden === false, null, 'An edit did not mark the issues as of an earlier model.');
  await view.click('#validate');
  await until(count => document.querySelectorAll('#validator-list [data-issue]').length > 0 && [...document.querySelectorAll('#validator-list .message')].length >= count, unusedBefore, 'Validate listed nothing.');
  const unusedWaiting = await unusedCount();
  assert(unusedWaiting === unusedBefore + 1, `With the actor's box deleted and waiting, the validator names it unused ${unusedWaiting} times rather than ${unusedBefore + 1}.`);
  await page.evaluate(() => window.broker.command('discard', null, 'toolbar'));
  await pendingIs(0, 'Discarded');
  await view.click('#validate');
  await until(count => document.querySelector('#validator-list .stale')?.hidden === true, null, 'Validate after Discard did not run.');
  assert(await unusedCount() === unusedBefore, 'After Discard the validator still names the actor unused.');
  await page.evaluate(() => window.broker.command('validator', false, 'toolbar'));
  results.validator.whileEditing = { unused: [unusedBefore, unusedWaiting] };
  assert((await nodeIds()).length === objectsStored, 'Discard did not bring the deleted box back.');

  // A refused commit keeps the edits waiting, and the file as it was.
  const again = await boxOf(moving);
  await drag({ x: again.x + 8, y: again.y + again.height / 2 }, 0, 40);
  await pendingIs(1, 'A box dragged down');
  const refusedBatch = (await batches()).length;
  await page.evaluate(() => window.broker.fail('records.batch', { code: 'record-version-conflict', message: 'The record changed since it was read.' }));
  await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
  await until(() => /was refused/.test(document.getElementById('status').textContent), null, 'A refused commit was not reported.');
  await pendingIs(1, 'After a refused commit the edit still waits');
  assert((await storedItem(moving)).values['ar.item.y'] === movedTo.values['ar.item.y'], 'A refused commit changed the file.');

  // The waiting edit survives the workbench starting again, and opens the editor with it.
  await page.evaluate(place => { window.broker.startAt(place); window.broker.remount(); }, { view: editedView.recordId, selected: editedView.recordId, item: null });
  view = null;
  for (let attempt = 0; attempt < 400 && view === null; attempt += 1) {
    const candidate = page.frames().filter(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')).at(-1);
    if (candidate && await candidate.evaluate(() => document.querySelectorAll('.archi-editor [data-node-id]').length > 0).catch(() => false)) view = candidate;
    else await page.waitForTimeout(25);
  }
  assert(view !== null, 'A workbench started again with an edit waiting did not open the view in the editor.');
  await pendingIs(1, 'Started again');
  await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
  await pendingIs(0, 'The kept edit committed');
  assert((await storedItem(moving)).values['ar.item.y'] > movedTo.values['ar.item.y'], 'The kept edit did not reach the file.');
  // ---- W-113: an element box dropped into another element box is nested in it, and Archi asks
  // which relationship the nesting stands for (archi-online's own dialog, with None among the
  // choices). The move waits like any other edit and commits with the relationship chosen.
  {
    // Organisation Tree View: its element boxes stand at the top of the view, not inside groups.
    const treeView = (await records('ar.view')).find(record => record.values['ar.view.name'] === 'Organisation Tree View');
    await page.evaluate(value => window.broker.command('find', value, 'toolbar'), treeView.values['ar.view.name']);
    await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), treeView.recordId, 'Organisation Tree View is not in the tree under Find.');
    await view.click(`#tree .row[data-id="${treeView.recordId}"]`);
    await until(() => document.querySelectorAll('.archi-editor [data-node-id]').length > 10, null, 'The editor did not show Organisation Tree View.');
    await page.evaluate(() => window.broker.command('find', '', 'toolbar'));
    const conceptsNow = await records('ar.concept');
    const conceptOf = new Map(conceptsNow.map(record => [record.recordId, record]));
    const typeKey = new Map((await records('ar.type')).map(record => [record.recordId, record.values['ar.type.key']]));
    const related = conceptsNow.filter(record => record.values['ar.concept.category'] === 'Relationship')
      .map(record => `${record.values['ar.concept.source']} ${record.values['ar.concept.target']}`);
    const boxes = (await records('ar.item')).filter(item => item.values['ar.item.view'] === treeView.recordId &&
      item.values['ar.item.kind'] === 'Element' && !item.values['ar.item.parent'])
      .map(item => ({ id: item.recordId, concept: item.values['ar.item.concept'], width: item.values['ar.item.width'],
        type: typeKey.get(conceptOf.get(item.values['ar.item.concept'])?.values['ar.concept.type']) }));
    const pair = await view.evaluate(async ({ boxes, related }) => {
      const { validRelationshipTypes } = await import('./canvas.js');
      for (const container of boxes) for (const child of boxes) {
        if (container.id === child.id || container.width < 120 || !container.type || !child.type) continue;
        if (related.includes(`${container.concept} ${child.concept}`) || related.includes(`${child.concept} ${container.concept}`)) continue;
        const allowed = validRelationshipTypes(container.type, child.type);
        if (['CompositionRelationship', 'AggregationRelationship', 'AssignmentRelationship'].some(type => allowed.includes(type)))
          return { container, child };
      }
      return null;
    }, { boxes, related });
    assert(pair, 'No two boxes on Organisation Tree View can be nested with a new relationship.');
    const childAt = await boxOf(pair.child.id), containerAt = await boxOf(pair.container.id);
    const from = { x: childAt.x + 6, y: childAt.y + childAt.height / 2 };
    await drag(from, containerAt.x + containerAt.width / 2 - from.x, containerAt.y + containerAt.height / 2 - from.y);
    const asked = await view.waitForFunction(() => {
      const dialog = document.querySelector('.app-dialog');
      return dialog && dialog.querySelector('select') ? { title: dialog.querySelector('.app-dialog-title')?.textContent ?? '',
        choices: [...dialog.querySelectorAll('select option')].map(option => option.value) } : null;
    }, null, { timeout: 4000, polling: 50 }).then(handle => handle.jsonValue()).catch(() => null);
    assert(asked !== null, `A box dropped into another element box asked nothing about the nesting, and the move is not waiting: Commit says ${JSON.stringify(await toolbarItem('commit'))}.`);
    const chosen = asked.choices.find(value => value !== '');
    await view.selectOption('.app-dialog select', chosen);
    await view.click('.app-dialog button[type="submit"]');
    await view.waitForFunction(() => !document.querySelector('.app-dialog'), null, { timeout: 4000 });
    await page.waitForFunction(() => {
      const find = items => { for (const item of items ?? []) { if (item.id === 'commit') return item; const inner = find(item.items); if (inner) return inner; } return null; };
      return /^Commit \d+$/.test(find(window.broker.toolbars.at(-1)?.items)?.label ?? '');
    }, null, { timeout: 8000, polling: 50 });
    await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
    await pendingIs(0, 'The nesting committed');
    const nested = await storedItem(pair.child.id);
    const relationship = (await records('ar.concept')).find(record => record.values['ar.concept.category'] === 'Relationship' &&
      record.values['ar.concept.source'] === pair.container.concept && record.values['ar.concept.target'] === pair.child.concept);
    assert(nested.values['ar.item.parent'] === pair.container.id && relationship,
      `The nesting did not reach the file: parent ${nested.values['ar.item.parent']}, relationship ${JSON.stringify(relationship?.values ?? null)}.`);
    results.nesting = { title: asked.title, choices: asked.choices.length, chosen, relationship: typeKey.get(relationship.values['ar.concept.type']) };

    // ---- W-113: Arrange, from Nendo's row, on a selection made with real clicks (Ctrl adds). Each
    // command commits what archi-online's own operation makes of the same records and selection
    // (arrangeModel in canvas.js), is one edit waiting and one Undo step, and commits as one batch.
    // Four short menus, each holding only its own commands (the owner found one menu of 27 crowded).
    const editingMenus = {};
    for (const id of ['arrange', 'clipboard', 'layout', 'editor-settings']) editingMenus[id] = (await toolbarItem(id))?.items?.filter(entry => entry.id).map(entry => entry.id) ?? null;
    assert(JSON.stringify(editingMenus) === JSON.stringify({
      arrange: ['align-left', 'align-center', 'align-right', 'align-top', 'align-middle', 'align-bottom', 'match-width', 'match-height', 'match-size',
        'distribute-horizontal', 'distribute-vertical', 'order-front', 'order-forward', 'order-backward', 'order-back'],
      clipboard: ['cut', 'copy', 'paste', 'paste-reference', 'paste-copy', 'duplicate', 'select-same-type'],
      layout: ['layout-right', 'layout-down'],
      'editor-settings': ['grid', 'snap', 'guides', 'automatic-relationships'],
    }), `Editing does not put Arrange, Copy and paste, Lay out and the editor's settings in Nendo's row as four menus: ${JSON.stringify(editingMenus)}.`);
    const allSets = async () => Object.fromEntries(await Promise.all(['ar.model', 'ar.folder', 'ar.type', 'ar.concept', 'ar.specialization', 'ar.view', 'ar.item', 'ar.property']
      .map(async entityId => [entityId, await records(entityId)])));
    const boxNamed = async name => {
      const named = (await records('ar.concept')).find(record => record.values['ar.concept.name'] === name);
      return (await records('ar.item')).find(item => item.values['ar.item.view'] === treeView.recordId && item.values['ar.item.concept'] === named?.recordId);
    };
    const selectBoxes = async names => {
      const ids = [];
      for (const [index, name] of names.entries()) {
        const item = await boxNamed(name);
        const at = await boxOf(item.recordId);
        if (index > 0) await page.keyboard.down('Control');
        await page.mouse.click(editFrame.x + at.x + 10, editFrame.y + at.y + at.height - 8);
        if (index > 0) await page.keyboard.up('Control');
        ids.push(item.recordId);
      }
      return ids;
    };
    const waiting = async () => {
      await page.waitForFunction(() => {
        const find = items => { for (const item of items ?? []) { if (item.id === 'commit') return item; const inner = find(item.items); if (inner) return inner; } return null; };
        return /^Commit \d+$/.test(find(window.broker.toolbars.at(-1)?.items)?.label ?? '');
      }, null, { timeout: 8000, polling: 50 });
    };
    const arranged = {};
    for (const [command, names] of [['align-left', ['Director of Operations', 'Intermediary Relations', 'Board']], ['match-size', ['Director of Sales', 'Director of Operations']],
      ['distribute-vertical', ['Board', 'Director of Finance', 'Customer Relations']], ['order-back', ['Car']]]) {
      const ids = await selectBoxes(names);
      const sets = await allSets();
      const reference = await view.evaluate(async ({ sets, viewId, ids, command }) => {
        const canvas = await import('./canvas.js');
        const { refusal, model } = canvas.arrangeModel(canvas.buildMirror(sets), viewId, ids, command);
        return { refusal, bounds: Object.fromEntries(ids.map(id => [id, model.nodes[id].bounds])), order: model.views[viewId].childIds };
      }, { sets, viewId: treeView.recordId, ids, command });
      assert(reference.refusal === null, `archi-online refused ${command} on ${names.join(', ')}: ${reference.refusal}.`);
      const batchesBeforeCommand = (await batches()).length;
      await page.evaluate(id => window.broker.command(id, null, 'toolbar'), command);
      await waiting();
      if (command === 'align-left') {
        await page.evaluate(() => window.broker.command('undo', null, 'toolbar'));
        await pendingIs(0, 'Align left undone');
        await page.evaluate(() => window.broker.command('redo', null, 'toolbar'));
        await waiting();
      }
      await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
      await pendingIs(0, `${command} committed`);
      const committed = (await batches()).slice(batchesBeforeCommand);
      const items = await records('ar.item');
      const stored = id => { const values = items.find(item => item.recordId === id).values; return { x: values['ar.item.x'], y: values['ar.item.y'], width: values['ar.item.width'], height: values['ar.item.height'] }; };
      const differing = ids.filter(id => JSON.stringify(stored(id)) !== JSON.stringify({ x: reference.bounds[id].x, y: reference.bounds[id].y, width: reference.bounds[id].width, height: reference.bounds[id].height }));
      assert(committed.length === 1 && differing.length === 0,
        `${command} on ${names.join(', ')} committed ${committed.length} batches, and ${differing.length} boxes differ from archi-online's: ${JSON.stringify(differing.map(id => [stored(id), reference.bounds[id]]))}.`);
      // What each command means, measured on the boxes themselves, not through archi-online's code:
      // the last box selected is the anchor.
      const after = ids.map(stored), anchorBox = after.at(-1);
      const before = ids.map(id => { const values = sets['ar.item'].find(item => item.recordId === id).values; return { x: values['ar.item.x'], y: values['ar.item.y'], width: values['ar.item.width'], height: values['ar.item.height'] }; });
      const meant = command === 'align-left' ? after.every(box => box.x === before.at(-1).x) && new Set(before.map(box => box.width)).size === before.length
        : command === 'match-size' ? after.every(box => box.width === anchorBox.width && box.height === anchorBox.height) && JSON.stringify(anchorBox) === JSON.stringify(before.at(-1))
        : command === 'distribute-vertical' ? (() => { const sorted = [...after].sort((p, q) => p.y - q.y); const gaps = [sorted[1].y - (sorted[0].y + sorted[0].height), sorted[2].y - (sorted[1].y + sorted[1].height)]; return Math.abs(gaps[0] - gaps[1]) <= 1; })()
        : true;
      assert(meant, `${command} on ${names.join(', ')} did not do what it says: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}.`);
      if (command === 'order-back') {
        const storedOrder = items.filter(item => item.values['ar.item.view'] === treeView.recordId && !item.values['ar.item.parent'] && !/onnection/.test(item.values['ar.item.kind']))
          .sort((a, b) => (a.values['ar.item.order'] ?? 1e15) - (b.values['ar.item.order'] ?? 1e15) || (a.recordId < b.recordId ? -1 : 1)).map(item => item.recordId);
        assert(JSON.stringify(storedOrder) === JSON.stringify(reference.order) && reference.order[0] === ids[0],
          `Send to back left the view's order ${JSON.stringify(storedOrder)}, not archi-online's ${JSON.stringify(reference.order)}.`);
      }
      arranged[command] = { boxes: ids.length, writes: committed[0].writes.length };
    }
    // Duplicate, and copy with paste as reference and as copy: new boxes, for the same element or a new one.
    // Finance, because nothing above moved a box over it; a click selects the box drawn on top.
    const conceptCount = async () => (await records('ar.concept')).length;
    const pasted = {};
    for (const [command, names, sameElement] of [['duplicate', ['Car'], false], ['paste-reference', ['Finance'], true], ['paste-copy', ['Finance'], false]]) {
      const ids = await selectBoxes(names);
      const source = (await records('ar.item')).find(item => item.recordId === ids[0]);
      if (command !== 'duplicate') await page.evaluate(() => window.broker.command('copy', null, 'toolbar'));
      const itemsBefore = new Set((await records('ar.item')).map(item => item.recordId));
      const conceptsBefore = await conceptCount();
      await page.evaluate(id => window.broker.command(id, null, 'toolbar'), command);
      await waiting();
      await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
      await pendingIs(0, `${command} committed`);
      const made = (await records('ar.item')).filter(item => !itemsBefore.has(item.recordId));
      const concepts = await conceptCount();
      const newBox = made.find(item => item.values['ar.item.kind'] === 'Element');
      const fine = newBox && newBox.values['ar.item.view'] === treeView.recordId &&
        (sameElement ? newBox.values['ar.item.concept'] === source.values['ar.item.concept'] && concepts === conceptsBefore
          : newBox.values['ar.item.concept'] !== source.values['ar.item.concept'] && concepts === conceptsBefore + 1);
      assert(fine, `${command} of ${names[0]} did not make a new box for ${sameElement ? 'the same' : 'a new'} element: ${JSON.stringify({ made: made.map(item => item.values['ar.item.concept']), source: source.values['ar.item.concept'], conceptsBefore, concepts })}.`);
      pasted[command] = { boxes: made.length, newElements: concepts - conceptsBefore };
    }
    // The grid, shown and hidden from Nendo's row, as the editor's own menu does.
    await page.evaluate(() => window.broker.command('grid', true, 'toolbar'));
    await until(() => !!document.querySelector('.archi-editor .view-grid'), null, 'Show grid drew no grid.');
    for (let attempt = 0; attempt < 200 && (await toolbarItem('grid'))?.checked !== true; attempt++) await page.waitForTimeout(25);
    assert((await toolbarItem('grid'))?.checked === true, "The editor's settings do not show the grid as on.");
    await page.evaluate(() => window.broker.command('grid', false, 'toolbar'));
    await until(() => !document.querySelector('.archi-editor .view-grid'), null, 'Hiding the grid left it drawn.');
    results.arrange = { arranged, pasted };

    // ---- W-114: how a box looks, in archi-online's own Appearance and Label tabs beside the view.
    // Each change waits like a move and commits to the box's record; a font chosen there keeps
    // Archi's own string; the label expression is drawn; and the workbench started again shows
    // every value in the tabs.
    const board = await boxNamed('Board');
    // Hidden at first, the panel opens from the Appearance toggle in Nendo's row.
    assert(await view.evaluate(() => document.querySelector('.archi-style')?.hidden === true), 'The Appearance panel was shown before it was asked for.');
    await page.evaluate(() => window.broker.command('appearance', true, 'toolbar'));
    await until(() => document.querySelector('.archi-style')?.hidden === false, null, 'The Appearance toggle did not show the panel.');
    const styleControl = label => view.locator(`.archi-style .appearance-field:has(> label:text-is("${label}")) .appearance-control`);
    // Showing the panel narrows the canvas, which draws again; the box is clicked where it now is.
    const selectBoard = async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const at = await boxOf(board.recordId);
        await page.mouse.click(editFrame.x + at.x + 10, editFrame.y + at.y + at.height - 8);
        await page.waitForTimeout(150);
        if (await view.evaluate(() => !!document.querySelector('.archi-style [data-style-tab="appearance"]'))) return;
      }
      throw new Error('Selecting a box did not show its Appearance tab: ' + JSON.stringify(await view.evaluate(() => document.querySelector('.archi-style')?.textContent?.slice(0, 120))));
    };
    await selectBoard();
    // The tabs in Nendo's manner: the chosen one raised in ink on the raised surface, no accent line.
    const tabLook = await view.evaluate(() => {
      const resolve = (property, value) => { const probe = document.createElement('span'); probe.style[property] = value; document.body.append(probe); const out = getComputedStyle(probe)[property]; probe.remove(); return out; };
      const active = getComputedStyle(document.querySelector('.archi-style [data-style-tab="appearance"]'));
      return { color: active.color, ink: resolve('color', 'var(--ink)'), background: active.backgroundColor, raised: resolve('backgroundColor', 'var(--surface-raised)'),
        shadow: active.boxShadow, accent: resolve('color', 'var(--cobalt)') };
    });
    assert(tabLook.color === tabLook.ink && tabLook.background === tabLook.raised && !tabLook.shadow.includes(tabLook.accent),
      `The chosen tab is not drawn in Nendo's manner: ${JSON.stringify(tabLook)}.`);
    await styleControl('Fill Colour').locator('input[type="color"]').fill('#ff8800');
    await styleControl('Gradient').locator('select').selectOption('1');
    await styleControl('Line Width').locator('select').selectOption('3');
    await styleControl('Font').locator('input[type="number"]').fill('14');
    await styleControl('Font').locator('button', { hasText: 'B' }).click();
    await view.click('.archi-style [data-style-tab="label"]');
    const expression = view.locator('.archi-style textarea[aria-label="Label expression"]');
    await expression.fill('${type}: ${name}');
    await expression.press('Tab');
    const preview = await view.locator('.archi-style .label-expression-preview').textContent();
    assert(preview === 'Business Actor: Board', `The Label tab previews "${preview}".`);
    await waiting();
    await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
    await pendingIs(0, 'The appearance committed');
    const styled = (await records('ar.item')).find(item => item.recordId === board.recordId).values;
    const font = String(styled['ar.item.font'] ?? '').split('|');
    assert(styled['ar.item.fillColor'] === '#ff8800' && styled['ar.item.gradient'] === 1 && styled['ar.item.lineWidth'] === 3 &&
      font[0] === '1' && font[2] === '14' && font[3] === '1' && styled['ar.item.labelExpression'] === '${type}: ${name}',
      `Board's record does not hold what the tabs set: ${JSON.stringify({ fill: styled['ar.item.fillColor'], gradient: styled['ar.item.gradient'], lineWidth: styled['ar.item.lineWidth'], font: styled['ar.item.font'], label: styled['ar.item.labelExpression'] })}.`);
    await until(() => [...document.querySelectorAll('.archi-editor text, .archi-editor div')].some(node => node.textContent === 'Business Actor: Board'), null,
      'The view does not draw Board by its label expression.');
    // Started again, the tabs show what the record holds.
    await page.evaluate(place => { window.broker.startAt(place); window.broker.remount(); }, { view: treeView.recordId, selected: treeView.recordId, item: null });
    view = null;
    for (let attempt = 0; attempt < 400 && view === null; attempt += 1) {
      const candidate = page.frames().filter(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')).at(-1);
      if (candidate && await candidate.evaluate(() => !!document.querySelector('.canvas-host .paper')).catch(() => false)) view = candidate;
      else await page.waitForTimeout(25);
    }
    assert(view !== null, 'The workbench did not start again on Organisation Tree View.');
    await page.evaluate(() => window.broker.command('edit', true, 'toolbar'));
    await until(() => document.querySelectorAll('.archi-editor [data-node-id]').length > 10, null, 'Edit did not open again.');
    // Edit opened with the Appearance panel already shown, as this device keeps it: the whole
    // drawing is still in sight (the owner's report, W-114).
    const inSight = await view.waitForFunction(() => {
      const stage = document.querySelector('.archi-editor .view-svg')?.getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.archi-editor [data-node-id]')].map(node => node.getBoundingClientRect());
      return stage && boxes.length > 0 && boxes.every(box => box.left >= stage.left - 2 && box.top >= stage.top - 2 && box.right <= stage.right + 2 && box.bottom <= stage.bottom + 2);
    }, null, { timeout: 4000, polling: 50 }).then(() => true).catch(() => false);
    const cut = inSight ? 0 : await view.evaluate(() => {
      const stage = document.querySelector('.archi-editor .view-svg').getBoundingClientRect();
      return [...document.querySelectorAll('.archi-editor [data-node-id]')].filter(node => { const box = node.getBoundingClientRect(); return box.right > stage.right + 2 || box.bottom > stage.bottom + 2 || box.left < stage.left - 2 || box.top < stage.top - 2; }).length;
    });
    assert(inSight, `Edit opened with the Appearance panel shown and ${cut} boxes out of sight.`);
    // A view small enough to show at 100% is fitted too, as the drawing outside Edit is: centred,
    // not left in the corner (the owner, W-114).
    // In a window as large as the owner's, where the view fits at 100% and archi-online would leave it there.
    await page.setViewportSize({ width: 2600, height: 1500 });
    const smallView = (await records('ar.view')).find(record => record.values['ar.view.name'] === 'Application Structure View');
    await page.evaluate(value => window.broker.command('find', value, 'toolbar'), smallView.values['ar.view.name']);
    await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), smallView.recordId, 'Application Structure View is not in the tree under Find.');
    await view.click(`#tree .row[data-id="${smallView.recordId}"]`);
    const centred = await view.waitForFunction(count => {
      const stage = document.querySelector('.archi-editor .view-svg')?.getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.archi-editor [data-node-id]')].map(node => node.getBoundingClientRect());
      if (!stage || boxes.length !== count) return null;
      const left = Math.min(...boxes.map(box => box.left)), right = Math.max(...boxes.map(box => box.right));
      const top = Math.min(...boxes.map(box => box.top)), bottom = Math.max(...boxes.map(box => box.bottom));
      const off = { x: Math.round((left + right) / 2 - (stage.left + stage.right) / 2), y: Math.round((top + bottom) / 2 - (stage.top + stage.bottom) / 2) };
      return Math.abs(off.x) <= 3 && Math.abs(off.y) <= 3 ? off : null;
    }, (await records('ar.item')).filter(item => item.values['ar.item.view'] === smallView.recordId && !/onnection/.test(item.values['ar.item.kind'])).length,
    { timeout: 4000, polling: 50 }).then(handle => handle.jsonValue()).catch(() => null);
    assert(centred !== null, 'Edit left Application Structure View where it lies at 100%, not fitted and centred as the drawing outside Edit is.');
    await page.setViewportSize({ width: 1400, height: 860 });
    await page.evaluate(value => window.broker.command('find', value, 'toolbar'), treeView.values['ar.view.name']);
    await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), treeView.recordId, 'Organisation Tree View is not in the tree under Find.');
    await view.click(`#tree .row[data-id="${treeView.recordId}"]`);
    await until(() => document.querySelectorAll('.archi-editor [data-node-id]').length > 10, null, 'The editor did not show Organisation Tree View again.');
    await page.evaluate(() => window.broker.command('find', '', 'toolbar'));
    await selectBoard();
    const shown = await view.evaluate(() => {
      const control = label => [...document.querySelectorAll('.archi-style .appearance-field')].find(field => field.querySelector(':scope > label')?.textContent === label)?.querySelector('.appearance-control');
      return { fill: control('Fill Colour').querySelector('input[type="color"]').value, gradient: control('Gradient').querySelector('select').value,
        lineWidth: control('Line Width').querySelector('select').value, size: control('Font').querySelector('input[type="number"]').value,
        bold: [...control('Font').querySelectorAll('button')].find(button => button.textContent === 'B')?.classList.contains('active') };
    });
    assert(shown.fill === '#ff8800' && shown.gradient === '1' && shown.lineWidth === '3' && shown.size === '14' && shown.bold === true,
      `Started again, the Appearance tab shows ${JSON.stringify(shown)}.`);
    await view.click('.archi-style [data-style-tab="label"]');
    assert(await view.locator('.archi-style textarea[aria-label="Label expression"]').inputValue() === '${type}: ${name}', 'Started again, the Label tab lost the expression.');
    await page.evaluate(() => window.broker.command('appearance', false, 'toolbar'));
    await until(() => document.querySelector('.archi-style')?.hidden === true, null, 'The Appearance toggle did not hide the panel.');
    results.appearance = { fill: shown.fill, gradient: shown.gradient, lineWidth: shown.lineWidth, font: styled['ar.item.font'], label: preview };

    // ---- W-116: a view's viewpoint, picked in its properties from Archi's 25 by name, ghosts what
    // it leaves out and greys those types in the palette at once, in the editor and in the drawing
    // outside it, with nothing loaded again; None shows everything. What is ghosted is what
    // archi-online's rules name for the records as stored, box by box and line by line.
    {
      const picker = '#properties select[data-field="ar.view.viewpoint"]';
      await page.evaluate(value => window.broker.command('find', value, 'toolbar'), treeView.values['ar.view.name']);
      await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), treeView.recordId, 'Organisation Tree View is not in the tree under Find.');
      await view.click(`#tree .row[data-id="${treeView.recordId}"]`);
      await until(selector => !!document.querySelector(selector), picker, "The view's properties offer no viewpoint to pick.");
      await page.evaluate(() => window.broker.command('find', '', 'toolbar'));
      const offered = await view.evaluate(selector => [...document.querySelector(selector).options].map(option => [option.value, option.textContent]), picker);
      const table = await view.evaluate(async () => (await import('./canvas.js')).VIEWPOINTS.map(viewpoint => [viewpoint.id, viewpoint.name]));
      const tableByName = [...table].sort((a, b) => a[1].localeCompare(b[1]));
      assert(table.length === 25 && JSON.stringify(offered) === JSON.stringify([['', 'None'], ...tableByName]),
        `The viewpoint picker offers ${JSON.stringify(offered.slice(0, 4))}… (${offered.length}), not None and Archi's 25 by name.`);
      assert(await view.evaluate(selector => document.querySelector(selector).value, picker) === 'organization', "The picker does not show the view's viewpoint, organization.");
      // Nothing is loaded again: the page and the editor are the ones the steps above used.
      await view.evaluate(() => { window.viewpointMark = 'kept'; document.querySelector('.archi-editor').dataset.viewpointMark = 'kept'; });
      const expectedFor = async () => view.evaluate(async ({ sets, viewId }) => {
        const canvas = await import('./canvas.js');
        const model = canvas.buildMirror(sets);
        const viewpoint = model.views[viewId].viewpoint;
        return {
          viewpoint: viewpoint ?? null,
          boxes: Object.keys(model.nodes).filter(id => model.nodes[id].viewId === viewId && canvas.isNodeGhosted(model, id, viewpoint)).sort(),
          // The lines drawn: a connection nested boxes stand for is not (archi-online's geometry).
          lines: [...canvas.geometry(model, viewId).routes.keys()].filter(id => canvas.isConnectableGhosted(model, id, viewpoint)).sort(),
          types: sets['ar.type'].filter(type => type.values['ar.type.category'] === 'Element').map(type => type.values['ar.type.key'])
            .filter(key => !canvas.isAllowedElementInViewpoint(viewpoint, key)).sort(),
        };
      }, { sets: await allSets(), viewId: treeView.recordId });
      const drawn = scope => view.evaluate(scope => ({
        boxes: [...document.querySelectorAll(`${scope} [data-node-id] > [data-ghosted="true"]`)].map(node => node.parentElement.dataset.nodeId).sort(),
        lines: [...document.querySelectorAll(`${scope} [data-conn-id][data-ghosted="true"]`)].map(node => node.dataset.connId).sort(),
        opacity: [...new Set([...document.querySelectorAll(`${scope} [data-ghosted="true"]`)].map(node => getComputedStyle(node).opacity))],
        types: [...document.querySelectorAll('.archi-palette .pal-btn:disabled [data-palette-element]')].map(node => node.dataset.paletteElement).sort(),
        faint: [...new Set([...document.querySelectorAll('.archi-palette .pal-btn:disabled')].map(node => getComputedStyle(node).opacity))],
        kept: window.viewpointMark === 'kept' && (scope !== '.archi-editor' || document.querySelector('.archi-editor')?.dataset.viewpointMark === 'kept'),
      }), scope);
      const pick = async value => {
        await view.selectOption(picker, value);
        for (let waited = 0; ; waited += 50) {
          if (((await records('ar.view')).find(record => record.recordId === treeView.recordId).values['ar.view.viewpoint'] ?? '') === value) break;
          assert(waited < 8000, `Picking ${value || 'None'} did not reach the view's record.`);
          await page.waitForTimeout(50);
        }
        return expectedFor();
      };
      const shows = async (scope, expected, what) => {
        let seen = null;
        for (let waited = 0; waited <= 8000; waited += 50) {
          seen = await drawn(scope);
          if (JSON.stringify([seen.boxes, seen.lines]) === JSON.stringify([expected.boxes, expected.lines]) &&
            (scope !== '.archi-editor' || JSON.stringify(seen.types) === JSON.stringify(expected.types))) break;
          await page.waitForTimeout(50);
        }
        const fine = JSON.stringify(seen.boxes) === JSON.stringify(expected.boxes) && JSON.stringify(seen.lines) === JSON.stringify(expected.lines) &&
          (scope !== '.archi-editor' || JSON.stringify(seen.types) === JSON.stringify(expected.types)) && seen.kept &&
          (expected.boxes.length + expected.lines.length === 0 ? seen.opacity.length === 0 : JSON.stringify(seen.opacity) === '["0.4"]') &&
          (scope !== '.archi-editor' || (expected.types.length === 0 ? seen.faint.length === 0 : JSON.stringify(seen.faint) === '["0.35"]'));
        assert(fine, `${what}: ${expected.viewpoint ?? 'no viewpoint'} should ghost ${expected.boxes.length} boxes and ${expected.lines.length} lines` +
          `${scope === '.archi-editor' ? ` and grey ${expected.types.length} palette types` : ''}; drawn are ${seen.boxes.length} boxes and ${seen.lines.length} lines at ${JSON.stringify(seen.opacity)}` +
          `${scope === '.archi-editor' ? `, ${seen.types.length} palette types at ${JSON.stringify(seen.faint)}` : ''}, loaded again: ${!seen.kept}.`);
        return { boxes: seen.boxes.length, lines: seen.lines.length, types: seen.types.length };
      };
      const viewpoints = {};
      viewpoints.organization = await shows('.archi-editor', await expectedFor(), 'Editing, as stored');
      const strategy = await pick('strategy');
      assert(strategy.boxes.length > 10 && strategy.lines.length > 5 && strategy.types.length > 50,
        `Strategy leaves out only ${strategy.boxes.length} boxes, ${strategy.lines.length} lines and ${strategy.types.length} types of Organisation Tree View.`);
      viewpoints.strategyEditing = await shows('.archi-editor', strategy, 'Editing, after picking Strategy');
      await page.evaluate(() => window.broker.command('edit', false, 'toolbar'));
      await until(() => !!document.querySelector('.canvas-host .paper') && !document.querySelector('.archi-editor'), null, 'Leaving Edit did not return to the drawn view.');
      viewpoints.strategyDrawn = await shows('.canvas-host', strategy, 'Outside Edit, with Strategy');
      viewpoints.none = await shows('.canvas-host', await pick(''), 'Outside Edit, after picking None');
      assert((await records('ar.view')).find(record => record.recordId === treeView.recordId).values['ar.view.viewpoint'] == null, 'None did not clear the stored viewpoint.');
      viewpoints.organizationDrawn = await shows('.canvas-host', await pick('organization'), 'Outside Edit, after picking Organization again');
      await page.evaluate(() => window.broker.command('edit', true, 'toolbar'));
      await until(() => document.querySelectorAll('.archi-editor [data-node-id]').length > 10, null, 'Edit did not open again after the viewpoints.');
      await view.evaluate(() => { document.querySelector('.archi-editor').dataset.viewpointMark = 'kept'; });
      viewpoints.organizationEditing = await shows('.archi-editor', await expectedFor(), 'Editing again, with Organization');
      results.viewpoints = viewpoints;
    }

    // ---- W-115: Archi's automation, each archi-online's own operation with ELK in a worker.
    // Auto-layout from the Lay out menu commits what archi-online's layout makes of the same
    // records, as one Undo step and one batch of moves; the automatic relationships preferences
    // decide whether the line a nesting stands for is drawn; Generate View For makes a view of an
    // element and those related to it, laid out as archi-online lays it out, in one batch, opened
    // in the editor, and Undo there takes it away again.
    {
      const automation = {};
      const elkWorker = async () => view.evaluate(async () => (await fetch('vendor/elkjs/elk-worker.min.js')).ok);
      assert(await elkWorker(), 'The ELK worker is not in the package.');

      // One box selected lays out the whole view, as archi-online's scope says.
      const ids = await selectBoxes(['Board']);
      const sets = await allSets();
      const reference = await view.evaluate(async ({ sets, viewId, ids }) => {
        const canvas = await import('./canvas.js');
        const { refusal, model } = await canvas.layoutModel(canvas.buildMirror(sets), viewId, ids, 'down');
        const of = id => model.nodes[id]?.bounds ?? null;
        return { refusal, bounds: Object.fromEntries(Object.keys(model.nodes).filter(id => model.nodes[id].viewId === viewId).map(id => [id, of(id)])),
          bends: Object.fromEntries(Object.values(model.connections).filter(c => c.viewId === viewId).map(c => [c.id, c.bendpoints])) };
      }, { sets, viewId: treeView.recordId, ids });
      assert(reference.refusal === null, `archi-online refused to lay out Organisation Tree View: ${reference.refusal}.`);
      const batchesBeforeLayout = (await batches()).length;
      await page.evaluate(() => window.broker.command('layout-down', null, 'toolbar'));
      await waiting();
      await page.evaluate(() => window.broker.command('undo', null, 'toolbar'));
      await pendingIs(0, 'The layout undone');
      await page.evaluate(() => window.broker.command('redo', null, 'toolbar'));
      await waiting();
      await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
      await pendingIs(0, 'The layout committed');
      const laidOut = (await batches()).slice(batchesBeforeLayout);
      const itemsNow = await records('ar.item');
      const storedBounds = id => { const values = itemsNow.find(item => item.recordId === id).values; return { x: values['ar.item.x'], y: values['ar.item.y'], width: values['ar.item.width'], height: values['ar.item.height'] }; };
      const differing = Object.keys(reference.bounds).filter(id => JSON.stringify(storedBounds(id)) !== JSON.stringify(reference.bounds[id]));
      const bendsDiffer = Object.keys(reference.bends).filter(id => JSON.stringify(JSON.parse(itemsNow.find(item => item.recordId === id).values['ar.item.bendpoints'] ?? '[]')) !== JSON.stringify(reference.bends[id]));
      const top = itemsNow.filter(item => item.values['ar.item.view'] === treeView.recordId && !item.values['ar.item.parent'] && !/onnection/.test(item.values['ar.item.kind'])).map(item => storedBounds(item.recordId));
      const overlap = top.some((a, i) => top.slice(i + 1).some(b => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
      assert(laidOut.length === 1 && laidOut[0].writes.every(write => write.op === 'update') && differing.length === 0 && bendsDiffer.length === 0 && !overlap,
        `The layout committed ${laidOut.length} batches (${JSON.stringify(laidOut.map(batch => [...new Set(batch.writes.map(write => write.op))]))}); ${differing.length} boxes and ${bendsDiffer.length} lines differ from archi-online's, overlapping: ${overlap}.`);
      automation.layout = { boxes: top.length, writes: laidOut[0].writes.length };

      // The automatic relationships preferences: Archi's defaults shown; nested connections off
      // draws the line W-113's nesting stands for, in the editor; the defaults hide it again.
      const nestedLine = itemsNow.find(item => item.values['ar.item.concept'] === relationship.recordId && item.values['ar.item.view'] === treeView.recordId);
      assert(nestedLine, "W-113's nesting left no line for its relationship on the view.");
      const lineDrawn = () => view.evaluate(id => !!document.querySelector(`.archi-editor [data-conn-id="${id}"]`), nestedLine.recordId);
      assert(!(await lineDrawn()), 'The line a nesting stands for is drawn in the editor.');
      await page.evaluate(() => window.broker.command('automatic-relationships', null, 'toolbar'));
      await until(() => document.querySelector('#arm-settings')?.open === true, null, 'Automatic relationships opened no dialog.');
      const shownArm = await view.evaluate(() => ({
        checks: [...document.querySelectorAll('#arm-settings [data-arm]')].map(box => [box.dataset.arm, box.checked]),
        masks: [...document.querySelectorAll('#arm-settings [data-arm-mask]')].map(set => [set.dataset.armMask, set.querySelectorAll('input:checked').length, set.querySelectorAll('input').length]),
      }));
      assert(JSON.stringify(shownArm) === JSON.stringify({ checks: [['useNestedConnections', true], ['createRelationWhenAddingNewElementToContainer', true],
        ['createRelationWhenAddingModelTreeElementToContainer', true], ['createRelationWhenMovingElementToContainer', true]],
        masks: [['newRelationsTypes', 6, 11], ['newReverseRelationsTypes', 0, 11], ['hiddenRelationsTypes', 11, 11]] }),
        `The dialog does not show Archi's defaults: ${JSON.stringify(shownArm)}.`);
      await view.uncheck('#arm-settings [data-arm="useNestedConnections"]');
      await view.click('#arm-settings button[value="save"]');
      await until(id => !!document.querySelector(`.archi-editor [data-conn-id="${id}"]`), nestedLine.recordId, 'With nested connections off, the line a nesting stands for is still not drawn.');
      await page.evaluate(() => window.broker.command('automatic-relationships', null, 'toolbar'));
      await until(() => document.querySelector('#arm-settings')?.open === true, null, 'Automatic relationships did not open again.');
      await view.click('#arm-settings button[value="defaults"]');
      await until(id => !document.querySelector(`.archi-editor [data-conn-id="${id}"]`), nestedLine.recordId, "Archi's defaults did not hide the line again.");
      automation.nestedLine = { hidden: true, shownWhenOff: true };

      // Generate View For the element of a box selected on the view.
      const board = (await records('ar.concept')).find(record => record.values['ar.concept.name'] === 'Board');
      await selectBoxes(['Board']);
      const options = { focusIds: [board.recordId], name: 'Board View', depth: 1, direction: 'both', allInternalRelationships: false };
      const generatedReference = await view.evaluate(async ({ sets, options }) => {
        const canvas = await import('./canvas.js');
        const { result, model } = await canvas.generatedViewModel(canvas.buildMirror(sets), options);
        return { elements: result.elementIds, relationships: result.relationshipIds,
          bounds: Object.fromEntries(result.nodeIds.map(id => [model.nodes[id].elementId, model.nodes[id].bounds])) };
      }, { sets: await allSets(), options });
      const batchesBeforeGenerate = (await batches()).length;
      await page.evaluate(() => window.broker.command('generate-view', null, 'toolbar'));
      await until(() => document.querySelector('#generate-view')?.open === true, null, 'Generate view for opened no dialog.');
      const offered = await view.evaluate(() => ({ name: document.querySelector('#generate-view-name').value, depth: document.querySelector('#generate-view-depth').value,
        direction: document.querySelector('#generate-view-direction').value, viewpoints: document.querySelectorAll('#generate-view-viewpoint option').length }));
      assert(offered.name === 'Board View' && offered.depth === '1' && offered.direction === 'both' && offered.viewpoints > 1,
        `The dialog does not start from archi-online's defaults for Board: ${JSON.stringify(offered)}.`);
      await view.click('#generate-view button[value="generate"]');
      let generatedView = null;
      for (let waited = 0; !generatedView; waited += 50) {
        generatedView = (await records('ar.view')).find(record => record.values['ar.view.name'] === 'Board View');
        assert(waited < 15000, 'Generate View For made no view named Board View.');
        if (!generatedView) await page.waitForTimeout(50);
      }
      await pendingIs(0, 'The generated view saved');
      const generatedBatches = (await batches()).slice(batchesBeforeGenerate);
      const generatedItems = (await records('ar.item')).filter(item => item.values['ar.item.view'] === generatedView.recordId);
      const generatedBoxes = generatedItems.filter(item => item.values['ar.item.kind'] === 'Element');
      const generatedLines = generatedItems.filter(item => item.values['ar.item.kind'] === 'Relationship connection');
      const boundsDiffer = generatedBoxes.filter(item => JSON.stringify({ x: item.values['ar.item.x'], y: item.values['ar.item.y'], width: item.values['ar.item.width'], height: item.values['ar.item.height'] })
        !== JSON.stringify(generatedReference.bounds[item.values['ar.item.concept']]));
      assert(generatedBatches.length === 1 && generatedBatches[0].writes.every(write => write.op === 'create') && generatedBatches[0].writes.length === 1 + generatedItems.length &&
        JSON.stringify(generatedBoxes.map(item => item.values['ar.item.concept']).sort()) === JSON.stringify([...generatedReference.elements].sort()) &&
        JSON.stringify(generatedLines.map(item => item.values['ar.item.concept']).sort()) === JSON.stringify([...generatedReference.relationships].sort()) &&
        boundsDiffer.length === 0 && generatedBoxes.length > 1,
        `Generate View For saved ${generatedBatches.length} batches of ${JSON.stringify(generatedBatches.map(batch => batch.writes.length))} writes, ${generatedBoxes.length} boxes and ${generatedLines.length} lines ` +
        `where archi-online makes ${generatedReference.elements.length} and ${generatedReference.relationships.length}; ${boundsDiffer.length} boxes are placed elsewhere.`);
      await until(count => document.querySelectorAll('.archi-editor [data-node-id]').length === count, generatedBoxes.length, 'The generated view did not open in the editor.');
      // Undo takes it away as one step of the file's (W-112): one batch of deletes, nothing waiting.
      const batchesBeforeUndo = (await batches()).length;
      await labelIs('undo', 'Undo Generate view Board View', 'Undo does not name the generated view');
      await step('undo');
      await pendingIs(0, 'The generated view undone');
      const undone = (await batches()).slice(batchesBeforeUndo);
      const gone = !(await records('ar.view')).some(record => record.recordId === generatedView.recordId) &&
        !(await records('ar.item')).some(item => item.values['ar.item.view'] === generatedView.recordId);
      assert(undone.length === 1 && undone[0].writes.every(write => write.op === 'delete') && gone,
        `Undo did not take the generated view away in one batch of deletes: ${JSON.stringify(undone.map(batch => batch.writes.map(write => write.op)))}, gone: ${gone}.`);
      automation.generated = { boxes: generatedBoxes.length, lines: generatedLines.length, writes: generatedBatches[0].writes.length, undone: undone[0].writes.length };

      // Back to Organisation Tree View for the steps that follow.
      await page.evaluate(value => window.broker.command('find', value, 'toolbar'), treeView.values['ar.view.name']);
      await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), treeView.recordId, 'Organisation Tree View is not in the tree under Find.');
      await view.click(`#tree .row[data-id="${treeView.recordId}"]`);
      await until(() => document.querySelectorAll('.archi-editor [data-node-id]').length > 10, null, 'The editor did not show Organisation Tree View again.');
      await page.evaluate(() => window.broker.command('find', '', 'toolbar'));
      results.automation = automation;
    }
  }

  // Both themes: the palette and the menus take Nendo's colours; the paper stays white.
  const editorColours = {};
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.broker.pushTheme(value), mode);
    await until(expected => document.documentElement.dataset.nendoTheme === expected, mode, `The editor did not take the ${mode} theme.`);
    editorColours[mode] = await view.evaluate(() => {
      const surface = getComputedStyle(document.documentElement).getPropertyValue('--nendo-surface').trim();
      const probe = document.createElement('div'); probe.style.background = surface; document.body.append(probe);
      const token = getComputedStyle(probe).backgroundColor; probe.remove();
      return { palette: getComputedStyle(document.querySelector('.archi-editor .palette')).backgroundColor, token,
        paper: getComputedStyle(document.querySelector('.archi-editor .view-svg')).backgroundColor };
    });
    assert(editorColours[mode].palette === editorColours[mode].token && editorColours[mode].paper === 'rgb(255, 255, 255)',
      `In the ${mode} theme the editor's palette is not Nendo's surface, or its paper is not white: ${JSON.stringify(editorColours[mode])}.`);
  }
  await page.evaluate(() => { window.broker.startAt(null); window.broker.command('edit', false, 'toolbar'); });
  await until(() => !!document.querySelector('.canvas-host .paper') && !document.querySelector('.archi-editor'), null, 'Leaving Edit did not return to the drawn view.');
  results.edit = { view: editedView.values['ar.view.name'], refused, permitted, commits: (await batches()).length - batchesBefore, colours: editorColours, palette, selection: { box: boxMarks, line: lineMarks }, magic,
    ...(await (async () => {
      // What the session cost the file: the commits that were applied, a row per record created or
      // deleted and one per field set. The refused commit wrote nothing.
      const applied = (await batches()).filter((_, index) => index >= batchesBefore && index !== refusedBatch);
      return { revisions: applied.length, rows: applied.flatMap(batch => batch.writes).reduce((rows, write) => rows + (write.op === 'update' ? Object.keys(write.values).length : 1), 0) };
    })()) };
  }

  // ---- Both themes, measured: the page, the tree's selection and every native list take the theme's colours.
  const measured = {};
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.broker.pushTheme(value), mode);
    await until(value => document.documentElement.dataset.nendoTheme === value, mode, `The ${mode} theme did not reach the page.`);
    const tokens = await page.evaluate(value => window.broker.themes[value], mode);
    const colours = await view.evaluate(() => {
      const probe = value => { const span = document.createElement('span'); span.style.color = value; document.body.append(span); const c = getComputedStyle(span).color; span.remove(); return c; };
      const option = document.querySelector('#properties select option, #new-element-type option');
      return {
        canvas: getComputedStyle(document.body).backgroundColor, tree: getComputedStyle(document.querySelector('.tree-pane')).backgroundColor,
        selected: getComputedStyle(document.querySelector('#tree .row[aria-selected="true"]') ?? document.body).backgroundColor,
        option: option ? [getComputedStyle(option).color, getComputedStyle(option).backgroundColor] : null,
        expect: { canvas: probe('var(--nendo-canvas)'), surface: probe('var(--nendo-surface)'), cobaltSoft: probe('var(--nendo-cobalt-soft)'),
          ink: probe('var(--nendo-ink)'), raised: probe('var(--nendo-surface-raised)') },
        scheme: getComputedStyle(document.documentElement).colorScheme,
      };
    });
    assert(colours.canvas === colours.expect.canvas && colours.tree === colours.expect.surface && colours.selected === colours.expect.cobaltSoft,
      `The ${mode} theme's colours are not the page's: ${JSON.stringify(colours)}.`);
    assert(colours.option === null || (colours.option[0] === colours.expect.ink && colours.option[1] === colours.expect.raised),
      `A list in the ${mode} theme would not open in the theme's colours: ${JSON.stringify(colours.option)}.`);
    assert(colours.scheme === mode, `The page's colour scheme is ${colours.scheme} in the ${mode} theme.`);
    measured[mode] = { canvas: colours.canvas, selected: colours.selected, tokens: tokens.canvas };
    await page.screenshot({ path: `archi-workbench-${mode}.png` });
  }
  results.themes = measured;


  // ---- W-110: every element type in both figures and every relationship type draw, and a view of
  // 500 boxes pans without dropping frames.
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, '__ARCHI_GALLERY__');
  await until(() => /Every figure/.test(document.getElementById('tree').textContent) || true, null, 'The gallery did not arrive.');
  const openView = async (id, count) => {
    await page.evaluate(value => window.broker.command('find', value, 'toolbar'), id === 'ar-gv-figures' ? 'Every figure' : '500 objects');
    await until(value => !!document.querySelector(`#tree .row[data-id="${value}"]`), id, `${id} is not in the tree.`);
    const started = await view.evaluate(() => performance.now());
    await view.click(`#tree .row[data-id="${id}"]`);
    await until(n => document.querySelector('.canvas-host g.content')?.children.length === n + 1, count, `${id} was not drawn with ${count} objects.`);
    return (await view.evaluate(() => performance.now())) - started;
  };
  await openView('ar-gv-figures', 122);
  const figures = await view.evaluate(() => {
    const groups = [...document.querySelector('.canvas-host g.content').children].slice(0, 122);
    const shapes = groups.map(group => group.querySelectorAll('path, rect, ellipse, circle, polygon, polyline, line').length);
    const markup = groups.map(group => group.innerHTML.replace(/translate\([^)]*\)/g, ''));
    let differ = 0;
    for (let i = 0; i < 122; i += 2) if (markup[i] !== markup[i + 1]) differ++;
    const lines = document.querySelector('.canvas-host g.content').lastElementChild.querySelectorAll('path, polyline, line').length;
    return { empty: shapes.map((n, i) => n === 0 ? i : -1).filter(i => i >= 0), differ, lines };
  });
  assert(figures.empty.length === 0, `Some figures drew nothing: objects ${figures.empty.join(', ')}.`);
  assert(figures.lines >= 11, `The 11 relationship types drew ${figures.lines} lines.`);
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.broker.pushTheme(value), mode);
    await until(value => document.documentElement.dataset.nendoTheme === value, mode, `The ${mode} theme did not reach the page.`);
    const paint = await view.evaluate(() => ({ paper: getComputedStyle(document.querySelector('.canvas-host .paper')).fill,
      stage: getComputedStyle(document.querySelector('.canvas-host svg.stage')).backgroundColor,
      canvas: (() => { const s = document.createElement('span'); s.style.color = 'var(--nendo-canvas)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })() }));
    assert(paint.paper === 'rgb(255, 255, 255)' && paint.stage === 'rgb(255, 255, 255)', `In the ${mode} theme the view is not on white: ${JSON.stringify(paint)}.`);
    await page.screenshot({ path: `archi-figures-${mode}.png` });
  }
  const drawn = await openView('ar-gv-500', 500);
  // Frames are measured against the same window at rest: a browser that throttles to 30 a second
  // on a busy machine is not a dropped frame, a pan that repaints every figure is. A frame counts
  // as dropped when it takes more than half as long again as a frame at rest; the best of three
  // passes must drop fewer than one in twenty.
  const frames = await view.evaluate(async () => {
    const stage = document.querySelector('.canvas-host svg.stage');
    const pass = async panning => {
      const intervals = [];
      let last = await new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 0; i < 90; i++) {
        if (panning) stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: i % 30 < 15 ? 12 : -12, bubbles: true, cancelable: true }));
        const now = await new Promise(resolve => requestAnimationFrame(resolve));
        intervals.push(now - last);
        last = now;
      }
      intervals.sort((a, b) => a - b);
      return { median: intervals[45], p95: intervals[85], worst: intervals.at(-1), intervals };
    };
    const rest = await pass(false);
    const passes = [];
    for (let i = 0; i < 3; i++) {
      const panned = await pass(true);
      passes.push({ ...panned, dropped: panned.intervals.filter(ms => ms > rest.median * 1.5).length });
    }
    const best = passes.sort((a, b) => a.dropped - b.dropped)[0];
    return { restMedian: rest.median, median: best.median, p95: best.p95, worst: best.worst, dropped: best.dropped };
  });
  // Frames depend on what else the computer is doing, so they are reported, not judged: on the
  // owner's working desktop the same build dropped 1 and 32 frames in two runs. What is judged is
  // what the fix took out of each pan step: redrawing the navigator, which copies the whole view,
  // and declaring Nendo's toolbar. Over 60 pan steps the navigator's frame may follow a few times
  // as the camera rests, and the toolbar not at all.
  const toolbarsBefore = await page.evaluate(() => window.broker.toolbars.length);
  const panWork = await view.evaluate(async () => {
    const stage = document.querySelector('.canvas-host svg.stage');
    let navigatorMoves = 0;
    const watch = new MutationObserver(records => { navigatorMoves += records.filter(record => record.attributeName === 'x').length; });
    watch.observe(document.querySelector('.canvas-host .navigator-frame'), { attributes: true });
    for (let i = 0; i < 60; i++) {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: i % 30 < 15 ? 12 : -12, bubbles: true, cancelable: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    watch.disconnect();
    return { navigatorMoves };
  });
  panWork.toolbars = (await page.evaluate(() => window.broker.toolbars.length)) - toolbarsBefore;
  assert(panWork.navigatorMoves <= 30 && panWork.toolbars === 0,
    `A pan step does more than move the view: ${JSON.stringify(panWork)} over 60 steps.`);
  await page.evaluate(() => window.broker.command('find', '', 'toolbar'));
  results.figures = { types: 61, variantsThatDiffer: figures.differ, relationshipLines: figures.lines };
  results.performance = { drawMs: Math.round(drawn), frameMs: { rest: Math.round(frames.restMedian * 10) / 10, median: Math.round(frames.median * 10) / 10, p95: Math.round(frames.p95 * 10) / 10, dropped: frames.dropped }, panWork };

  // ---- A Nendo without its own row for the controls: the workbench draws them itself.
  await page.evaluate(() => { window.broker.offerChrome(false); window.broker.remount(); });
  view = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const frames = page.frames().filter(frame => !frame.isDetached() && frame.url().startsWith(origin + '/'));
    const candidate = frames.at(-1);
    if (candidate && await candidate.evaluate(() => getComputedStyle(document.getElementById('own-toolbar')).display !== 'none').catch(() => false)) { view = candidate; break; }
    await page.waitForTimeout(25);
  }
  assert(view !== null, 'Without Nendo’s row the workbench did not draw its own controls.');
  results.ownToolbar = true;

  // ---- R30-001: restore a real canvas diff with 101 new elements and boxes. Commit must
  // refuse all 202 writes before the broker receives any, preserving the stored draft.
  const boundView = fixture.records['ar.view'][0].recordId;
  const savedDraft = await view.evaluate(async ({ sets, viewId }) => {
    const { buildMirror, writesFor } = await import('./canvas.js');
    const before = buildMirror(sets), after = structuredClone(before);
    const opened = after.views[viewId];
    const folder = Object.values(after.folders).find(candidate => candidate.folderType === 'business');
    for (let index = 0; index < 101; index++) {
      const elementId = `ar-id-bound-element-${index}`, boxId = `ar-id-bound-box-${index}`;
      after.elements[elementId] = { id: elementId, kind: 'element', type: 'BusinessActor', name: `Actor ${index}`,
        documentation: '', properties: [], profileIds: [], folderId: folder.id };
      folder.itemIds.push(elementId);
      after.nodes[boxId] = { id: boxId, viewId, parentId: viewId, nodeType: 'element', elementId,
        bounds: { x: index * 10, y: 10, width: 120, height: 55 }, childIds: [], sourceConnectionIds: [], targetConnectionIds: [] };
      opened.childIds.push(boxId);
    }
    const saved = JSON.stringify({ viewId, writes: writesFor(sets, before, after) });
    localStorage.setItem('archi-edits', saved);
    return saved;
  }, { sets: fixture.records, viewId: boundView });
  assert(JSON.parse(savedDraft).writes.length === 202, 'The over-limit browser draft did not contain 202 dependent writes.');
  await page.evaluate(({ value, viewId }) => {
    window.broker.setFixture(value); window.broker.offerChrome(true);
    window.broker.startAt({ view: viewId, selected: viewId, item: null }); window.broker.remount();
  }, { value: fixture, viewId: boundView });
  view = null;
  for (let attempt = 0; attempt < 400 && view === null; attempt++) {
    const candidate = page.frames().filter(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')).at(-1);
    if (candidate && await candidate.evaluate(() => document.querySelectorAll('.archi-editor [data-node-id]').length > 101).catch(() => false)) view = candidate;
    else await page.waitForTimeout(25);
  }
  assert(view !== null, 'The 202-write draft did not reopen in the real editor.');
  const callsBeforeBound = await page.evaluate(() => window.broker.requests.filter(request => /^records\.(batch|create|update|delete)$/.test(request.m)).length);
  await page.evaluate(() => window.broker.command('commit', null, 'toolbar'));
  await until(() => /at most 200.*Nothing was saved/.test(document.getElementById('status').textContent), null, 'An over-limit Commit was not refused before saving.');
  const callsAfterBound = await page.evaluate(() => window.broker.requests.filter(request => /^records\.(batch|create|update|delete)$/.test(request.m)).length);
  assert(callsAfterBound === callsBeforeBound, `A 202-write Commit sent ${callsAfterBound - callsBeforeBound} write requests.`);
  assert((await records('ar.concept')).length === fixture.records['ar.concept'].length && (await records('ar.item')).length === fixture.records['ar.item'].length,
    'An over-limit Commit partially saved its elements or boxes.');
  assert(await view.evaluate(saved => localStorage.getItem('archi-edits') === saved, savedDraft), 'An over-limit Commit changed the saved editor draft.');
  results.commitBound = { planned: 202, requests: callsAfterBound - callsBeforeBound, retained: JSON.parse(savedDraft).writes.length };
  await page.evaluate(() => window.broker.command('discard', null, 'toolbar'));
  await until(() => localStorage.getItem('archi-edits') === null, null, 'Discard did not drop the over-limit draft.');
  await page.evaluate(() => { window.broker.startAt(null); window.broker.command('edit', false, 'toolbar'); });

  // ---- R30-004: both named and unnamed valid relationship cycles stay in the tree and
  // render selectable source/target links in Properties, in both themes.
  // run-code's sandbox has no structuredClone; the fixture is plain JSON.
  const cycleFixture = JSON.parse(JSON.stringify(fixture));
  const relationsFolder = fixture.records['ar.folder'].find(record => record.values['ar.folder.kind'] === 'Relations').recordId;
  const endpoint = fixture.records['ar.concept'].find(record => record.values['ar.concept.category'] === 'Element').recordId;
  const cycles = [];
  for (const named of [false, true]) for (const letter of ['A', 'B']) {
    const id = `ar-cycle-${named ? 'named' : 'unnamed'}-${letter}`;
    const other = `ar-cycle-${named ? 'named' : 'unnamed'}-${letter === 'A' ? 'B' : 'A'}`;
    cycleFixture.records['ar.concept'].push({ entityId: 'ar.concept', recordId: id, version: 1, values: {
      'ar.concept.name': named ? `Cycle ${letter}` : '', 'ar.concept.category': 'Relationship',
      'ar.concept.type': 'ar.type.r.ServingRelationship', 'ar.concept.folder': relationsFolder,
      'ar.concept.source': other, 'ar.concept.target': endpoint,
    }, labels: {} });
    cycles.push({ id, other, named });
  }
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, cycleFixture);
  await page.evaluate(() => window.broker.command('find', '[cycle]', 'toolbar'));
  await until(() => document.querySelectorAll('#tree .row[data-id^="ar-cycle-"]').length === 4, null, 'The tree did not retain all four cyclic relationships.');
  let propertyRenders = 0;
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.broker.pushTheme(value), mode);
    await until(value => document.documentElement.dataset.nendoTheme === value, mode, `The cyclic model did not take the ${mode} theme.`);
    for (const cycle of cycles) {
      await view.click(`#tree .row[data-id="${cycle.id}"]`);
      const rendered = await view.evaluate(() => ({ heading: document.querySelector('#properties h2')?.textContent,
        endpoints: [...document.querySelectorAll('#properties .field button[data-select]')].map(button => button.dataset.select) }));
      assert(rendered.heading.includes('[cycle]') && rendered.endpoints.includes(cycle.other) && rendered.endpoints.includes(endpoint),
        `A ${mode} cyclic relationship lost its properties/endpoints: ${JSON.stringify(rendered)}.`);
      if (cycle.named) assert(rendered.heading.startsWith('Cycle '), 'A cyclic relationship lost its explicit name.');
      propertyRenders++;
    }
  }
  results.relationshipCycles = { records: 4, propertyRenders, themes: 2 };

  // ---- W-120: Save as .archimate hands Archisurance to the browser's downloads as Archi's XML,
  // each object under the Archi ID it came with. Open into a file that already holds a model is
  // refused before anything is chosen. The XML saved here is what the new model opens below.
  // Archisurance as it was before the steps above edited it, so what is saved is its own.
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.startAt(null); window.broker.remount(); }, fixture);
  view = null;
  for (let attempt = 0; attempt < 400 && view === null; attempt++) {
    const candidate = page.frames().filter(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')).at(-1);
    if (candidate && await candidate.evaluate(() => /120 elements · 176 relationships · 17 views/.test(document.getElementById('status')?.textContent ?? '')).catch(() => false)) view = candidate;
    else await page.waitForTimeout(25);
  }
  assert(view !== null, 'The workbench did not start again on Archisurance.');
  const fileMenu = (await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(item => item.id === 'archi-file');
  assert(fileMenu && fileMenu.kind === 'menu' && fileMenu.items.filter(item => item.id).map(item => item.id).join() === 'open-archimate,open-exchange,save-archimate,save-exchange',
    `Nendo's row has no Archi file menu with Open and Save, for .archimate and Exchange XML: ${JSON.stringify(fileMenu)}.`);
  await view.evaluate(() => {
    window.savedBlobs = [];
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { window.savedBlobs.push(blob); return original(blob); };
  });
  const downloading = page.waitForEvent('download', { timeout: 8000 });
  await page.evaluate(() => window.broker.command('save-archimate', null, 'toolbar'));
  const download = await downloading;
  const savedXml = await view.evaluate(() => window.savedBlobs.at(-1).text());
  const kinds = [...savedXml.matchAll(/<element xsi:type="archimate:(\w+)"/g)].map(match => match[1]);
  const savedFile = { name: download.suggestedFilename(), views: kinds.filter(kind => kind === 'ArchimateDiagramModel').length,
    relationships: kinds.filter(kind => kind.endsWith('Relationship')).length };
  savedFile.elements = kinds.length - savedFile.views - savedFile.relationships;
  const savedIds = [...savedXml.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  assert(savedFile.name === 'Archisurance.archimate' && /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<archimate:model /.test(savedXml) &&
    savedFile.elements === 120 && savedFile.relationships === 176 && savedFile.views === 17,
    `Save as .archimate did not download Archisurance as Archi's XML: ${JSON.stringify(savedFile)}.`);
  assert(!savedIds.some(id => id.startsWith('ar-') || id.startsWith('ar.')) && new Set(savedIds).size === savedIds.length,
    'The saved file names an object by its record ID, or one ID twice.');
  await until(() => /^Saved Archisurance\.archimate, 120 elements/.test(document.getElementById('status').textContent), null, 'The status line did not say what was saved.');
  // W-121: Save as Exchange XML checks the file against Archi 5.9's schemas with libxml2, which
  // xsd.js brings only now, and downloads it only when it is valid.
  const xsdLoads = () => view.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\/xsd\.js(\?|$)/.test(entry.name)).length);
  const xsdBefore = await xsdLoads();
  const downloadingExchange = page.waitForEvent('download', { timeout: 20000 });
  await page.evaluate(() => window.broker.command('save-exchange', null, 'toolbar'));
  const exchangeDownload = await downloadingExchange;
  const exchangeXml = await view.evaluate(() => window.savedBlobs.at(-1).text());
  const exchangeFile = { name: exchangeDownload.suggestedFilename(), elements: (exchangeXml.match(/<element identifier=/g) ?? []).length,
    relationships: (exchangeXml.match(/<relationship identifier=/g) ?? []).length, views: (exchangeXml.match(/<view identifier=/g) ?? []).length,
    xsdBefore, xsdAfter: await xsdLoads() };
  assert(exchangeFile.name === 'Archisurance.xml' && exchangeXml.includes('xmlns="http://www.opengroup.org/xsd/archimate/3.0/"') &&
    exchangeFile.elements === 120 && exchangeFile.relationships === 176 && exchangeFile.views === 17 && exchangeFile.xsdBefore === 0 && exchangeFile.xsdAfter === 1,
    `Save as Exchange XML did not download Archisurance in The Open Group's format, with the schema check loaded for it alone: ${JSON.stringify(exchangeFile)}.`);
  await until(() => /^Saved Archisurance\.xml, valid against Archi 5\.9’s schemas, 120 elements/.test(document.getElementById('status').textContent), null,
    'The status line did not say the Exchange XML was saved valid.');
  results.saveExchange = { ...exchangeFile, bytes: exchangeXml.length };
  await page.evaluate(() => window.broker.command('open-archimate', null, 'toolbar'));
  await until(() => document.getElementById('open-archimate').open, null, 'Open .archimate… did not open its dialog.');
  const refusedOpen = await view.evaluate(() => ({ text: document.getElementById('open-archimate-text').textContent,
    choose: document.getElementById('open-archimate-choose').disabled, open: document.getElementById('open-archimate-open').disabled }));
  assert(/already holds a model/.test(refusedOpen.text) && /New Archi model/.test(refusedOpen.text) && refusedOpen.choose && refusedOpen.open,
    `Open into a file that holds a model was not refused before a file was chosen: ${JSON.stringify(refusedOpen)}.`);
  await view.click('#open-archimate button[value="cancel"]');
  results.saveArchimate = { ...savedFile, ids: savedIds.length, bytes: savedXml.length };

  // ---- W-123: every Archisurance view exports from Nendo's row as Archi exports a view: an SVG
  // cropped to the drawing with a 10-pixel margin, every element's name as SVG text in the
  // canvas's font, nothing left as HTML; PNG at 1×, 2× and 4× of that size; and a transparent
  // background when asked. Measured against archi-online's geometry of the same records.
  const exported = async () => view.evaluate(async () => {
    const blob = window.savedBlobs.at(-1);
    return blob ? { type: blob.type, size: blob.size, text: blob.type.includes('svg') ? await blob.text() : null,
      image: blob.type === 'image/png' ? await createImageBitmap(blob).then(bitmap => [bitmap.width, bitmap.height]) : null } : null;
  });
  const exportViews = (await records('ar.view')).sort((a, b) => (a.values['ar.view.name'] < b.values['ar.view.name'] ? -1 : 1));
  const allItems = await records('ar.item');
  const allConcepts = new Map((await records('ar.concept')).map(record => [record.recordId, record]));
  const svgOf = {};
  for (const exportView of exportViews) {
    await page.evaluate(value => window.broker.command('find', value, 'toolbar'), exportView.values['ar.view.name']);
    await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), exportView.recordId, `${exportView.values['ar.view.name']} is not in the tree under Find.`);
    await view.click(`#tree .row[data-id="${exportView.recordId}"]`);
    await until(() => !!document.querySelector('.canvas-host g.content'), null, `${exportView.values['ar.view.name']} was not drawn.`);
    let menu = null;
    for (let attempt = 0; attempt < 200 && !menu; attempt++) {
      menu = (await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(item => item.id === 'export') ?? null;
      if (!menu) await page.waitForTimeout(25);
    }
    assert(menu?.items.map(item => item.id).join() === 'export-png-1,export-png-2,export-png-4,export-svg,export-copy,export-transparent',
      `An open view has no Export menu with PNG, SVG, Copy and the background: ${JSON.stringify(menu)}; the row holds ${JSON.stringify((await page.evaluate(() => window.broker.toolbars.at(-1))).items.map(item => item.id ?? item.kind))}, refusals ${JSON.stringify(await page.evaluate(() => window.broker.chromeRefusals))}.`);
    const blobsBefore = await view.evaluate(() => window.savedBlobs.length);
    const svgDownload = page.waitForEvent('download', { timeout: 8000 });
    await page.evaluate(() => window.broker.command('export-svg', null, 'toolbar'));
    const svgName = (await svgDownload).suggestedFilename();
    await until(count => window.savedBlobs.length > count, blobsBefore, `${exportView.values['ar.view.name']} did not export an SVG.`);
    const file = await exported();
    const box = file.text.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/)?.slice(1).map(Number);
    const geometryOf = await view.evaluate(async ({ sets, viewId }) => (await import('./canvas.js')).geometryOf(sets, viewId), { sets: fixture.records, viewId: exportView.recordId });
    const xs = [], ys = [];
    for (const b of Object.values(geometryOf.bounds)) { xs.push(b.x, b.x + b.width); ys.push(b.y, b.y + b.height); }
    for (const route of Object.values(geometryOf.routes)) for (const point of route) { xs.push(point.x); ys.push(point.y); }
    const drawn = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
    const names = allItems.filter(item => item.values['ar.item.view'] === exportView.recordId && item.values['ar.item.kind'] === 'Element')
      .map(item => allConcepts.get(item.values['ar.item.concept'])?.values['ar.concept.name']).filter(Boolean);
    const texts = [...file.text.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>|<text[^>]*>([^<]+)<\/text>/g)].map(match => match[1] ?? match[2]).join('').replace(/\s+/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
    const missing = names.filter(name => !texts.includes(name.replace(/\s+/g, '')));
    const problems = [];
    if (svgName !== `${exportView.values['ar.view.name'].replace(/[\\/:*?"<>|]+/g, ' ').trim()}.svg`) problems.push(`named ${svgName}`);
    if (!box) problems.push('no viewBox');
    else {
      if (box[0] > drawn.left - 9 || box[1] > drawn.top - 9 || box[0] + box[2] < drawn.right + 9 || box[1] + box[3] < drawn.bottom + 9) problems.push(`cuts the drawing ${JSON.stringify(drawn)} with ${box}`);
      if (box[2] > drawn.right - drawn.left + 20 + 60 || box[3] > drawn.bottom - drawn.top + 20 + 60) problems.push(`is ${box[2]} × ${box[3]} round a drawing ${Math.round(drawn.right - drawn.left)} × ${Math.round(drawn.bottom - drawn.top)}`);
    }
    if (/<foreignObject/i.test(file.text)) problems.push('keeps HTML labels');
    if (!/<svg[^>]*style="[^"]*font-family:\s*(?:&quot;|'|")Segoe UI/.test(file.text)) problems.push(`is not in the canvas font: ${file.text.match(/<svg[^>]*>/)?.[0].slice(0, 300)}`);
    if (!/<rect[^>]*fill="#ffffff"/.test(file.text)) problems.push('has no white background');
    if (missing.length > 0) problems.push(`lacks ${missing.length} element names, first ${JSON.stringify(missing[0])}`);
    assert(problems.length === 0, `${exportView.values['ar.view.name']}'s SVG ${problems.join('; ')}.`);
    svgOf[exportView.recordId] = { width: box[2], height: box[3], names: names.length };
  }
  // PNG at each scale, and the transparent background, on the largest view.
  const largest = exportViews.reduce((best, candidate) => (svgOf[candidate.recordId].width * svgOf[candidate.recordId].height > svgOf[best.recordId].width * svgOf[best.recordId].height ? candidate : best));
  await page.evaluate(value => window.broker.command('find', value, 'toolbar'), largest.values['ar.view.name']);
  await until(id => !!document.querySelector(`#tree .row[data-id="${id}"]`), largest.recordId, 'The largest view is not in the tree under Find.');
  await view.click(`#tree .row[data-id="${largest.recordId}"]`);
  const pngs = {};
  for (const scale of [1, 2, 4]) {
    const before = await view.evaluate(() => window.savedBlobs.length);
    const pngDownload = page.waitForEvent('download', { timeout: 15000 });
    await page.evaluate(id => window.broker.command(id, null, 'toolbar'), `export-png-${scale}`);
    const pngName = (await pngDownload).suggestedFilename();
    await until(count => window.savedBlobs.length > count, before, `PNG at ${scale}× was not exported.`);
    const png = await exported();
    const expected = [Math.round(svgOf[largest.recordId].width * scale), Math.round(svgOf[largest.recordId].height * scale)];
    assert(png.type === 'image/png' && png.image[0] === expected[0] && png.image[1] === expected[1] && pngName === `${largest.values['ar.view.name']}.png`,
      `PNG at ${scale}× is ${JSON.stringify(png.image)} named ${pngName}, not ${JSON.stringify(expected)}.`);
    pngs[scale] = png.image;
  }
  await page.evaluate(() => window.broker.command('export-transparent', true, 'toolbar'));
  await page.waitForTimeout(100);
  const transparentBefore = await view.evaluate(() => window.savedBlobs.length);
  await page.evaluate(() => window.broker.command('export-svg', null, 'toolbar'));
  await until(count => window.savedBlobs.length > count, transparentBefore, 'The transparent SVG was not exported.');
  const transparent = await exported();
  assert(!/<rect[^>]*fill="#ffffff"/.test(transparent.text), 'Transparent background still drew the white page.');
  const checked = (await page.evaluate(() => window.broker.toolbars.at(-1))).items.find(item => item.id === 'export').items.find(item => item.id === 'export-transparent');
  assert(checked?.checked === true, 'The Export menu does not show the transparent background as chosen.');
  // Copy as picture, with Transparent background in files still chosen: the clipboard gets the white page.
  // Copy as picture, chosen in Nendo's row: focus is in the Workbench's page, as after a click in
  // its row, so the clipboard takes the PNG only because the view takes focus first (W-123, G36).
  await page.bringToFront();
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
  assert(await page.evaluate(() => document.hasFocus() && document.activeElement === document.body), 'The Workbench page did not hold focus before Copy.');
  await view.evaluate(() => {
    window.clipboardItems = [];
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = items => { window.clipboardItems.push(items); return write(items); };
  });
  await page.evaluate(() => window.broker.command('export-copy', null, 'toolbar'));
  await until(name => document.getElementById('status').textContent === `Copied ${name} to the clipboard as a picture.`, largest.values['ar.view.name'],
    'Copy as picture did not reach the clipboard.');
  // The picture itself, as handed to the clipboard: its size, a corner, and how much of it is
  // opaque, white, and drawn.
  const picture = await view.evaluate(async () => {
    const blob = await window.clipboardItems.at(-1)[0].getType('image/png');
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let opaque = 0, white = 0, inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 255) opaque++;
      if (data[i + 3] === 255 && data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) white++;
      else if (data[i + 3] > 0) inked++;
    }
    const pixels = data.length / 4;
    return { width: bitmap.width, height: bitmap.height, corner: [...data.slice(0, 4)], opaque: opaque / pixels, white: white / pixels, inked: inked / pixels, type: blob.type };
  });
  results.copiedPicture = picture;
  assert(picture.width === svgOf[largest.recordId].width * 2 && picture.height === svgOf[largest.recordId].height * 2 && picture.opaque === 1 &&
    picture.corner.join() === '255,255,255,255' && picture.inked > 0.05,
    `Copy as picture did not hand the clipboard the view on its white page: ${JSON.stringify(picture)}.`);
  await page.evaluate(() => window.broker.command('export-transparent', false, 'toolbar'));
  results.exportViews = { views: exportViews.length, largest: largest.values['ar.view.name'], svg: svgOf[largest.recordId], pngs,
    names: Object.values(svgOf).reduce((sum, entry) => sum + entry.names, 0) };

  // ---- W-130 (ADR-0022): a new Archi model keeps the concept types and the top-level folders
  // and leaves the Model record out with the work. The workbench starts one empty model, so the
  // tree has a root, and the nine folders sit under it. Measured in the broker's records.
  const fresh = JSON.parse(JSON.stringify(fixture));
  for (const key of Object.keys(fresh.records)) if (key !== 'ar.type' && key !== 'ar.folder') fresh.records[key] = [];
  fresh.records['ar.folder'] = fresh.records['ar.folder'].filter(record => !record.values['ar.folder.parent']);
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.startAt(null); window.broker.remount(); }, fresh);
  let models = [];
  for (let attempt = 0; attempt < 400 && models.length === 0; attempt++) {
    models = await records('ar.model');
    if (models.length === 0) await page.waitForTimeout(25);
  }
  assert(models.length === 1 && models[0].values['ar.model.name'] === 'New model',
    `The workbench did not start one empty model in a file without one: ${JSON.stringify(models)}.`);
  view = null;
  for (let attempt = 0; attempt < 400 && view === null; attempt++) {
    const candidate = page.frames().filter(frame => !frame.isDetached() && frame.url().startsWith(origin + '/')).at(-1);
    if (candidate && await candidate.evaluate(() => document.querySelectorAll('#tree .row').length >= 10).catch(() => false)) view = candidate;
    else await page.waitForTimeout(25);
  }
  assert(view !== null, 'The new model’s tree did not show its root and the nine folders.');
  const freshRows = await rows();
  assert(freshRows[0].id === models[0].recordId && freshRows.slice(1).filter(row => row.level === 2).length === 9,
    `The new model's tree is not one root over nine folders: ${JSON.stringify(freshRows.slice(0, 11))}.`);
  await page.waitForTimeout(300);
  assert((await records('ar.model')).length === 1, 'The workbench started more than one model.');
  results.emptyModel = { models: 1, folders: 9 };

  // ---- W-120: the saved Archisurance opens into the new model. A dropped file opens the dialog
  // with what it holds and Cancel writes nothing; the picker opens on a click inside the view, and
  // Open saves the model in batches of at most 200, after which the records are Archisurance's own.
  const dropFile = xml => view.evaluate(text => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], 'Archisurance.archimate', { type: 'application/xml' }));
    document.getElementById('centre').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, xml);
  const batchesBeforeDrop = await page.evaluate(() => window.broker.requests.filter(request => request.m === 'records.batch').length);
  // W-121: an Open Exchange file dropped on the workbench is told from an .archimate by what it
  // holds, and read in the browser as archi-online reads it; Cancel writes nothing.
  await view.evaluate(text => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], 'Archisurance.xml', { type: 'application/xml' }));
    document.getElementById('centre').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, exchangeXml);
  await until(() => document.getElementById('open-archimate').open &&
    /^Archisurance: 120 elements, 176 relationships, 17 views\. Read as Open Exchange XML\.$/.test(document.getElementById('open-archimate-summary').textContent), null,
    'A dropped Exchange XML file did not open the dialog saying what it holds, read as Open Exchange XML.');
  await view.click('#open-archimate button[value="cancel"]');
  await until(() => !document.getElementById('open-archimate').open, null, 'Cancel left the dialog open.');
  await dropFile(savedXml);
  await until(() => document.getElementById('open-archimate').open &&
    /^Archisurance: 120 elements, 176 relationships, 17 views\.$/.test(document.getElementById('open-archimate-summary').textContent), null,
    'A dropped .archimate file did not open the dialog saying what it holds.');
  await view.click('#open-archimate button[value="cancel"]');
  await page.waitForTimeout(300);
  assert((await records('ar.concept')).length === 0 && (await page.evaluate(() => window.broker.requests.filter(request => request.m === 'records.batch').length)) === batchesBeforeDrop,
    'Cancel wrote the dropped model.');
  const savesBefore = await page.evaluate(() => window.broker.requests.filter(request => request.m === 'records.batch').length);
  await page.evaluate(() => window.broker.command('open-archimate', null, 'toolbar'));
  await until(() => document.getElementById('open-archimate').open && !document.getElementById('open-archimate-choose').disabled, null,
    'Open .archimate… did not offer a choice in the new, empty model.');
  // Choose clicks the dialog's file input with the person's activation, which is what opens
  // Windows' picker in a view (W-104, G34). The click is caught rather than let through: the CLI
  // stops running this probe, and still exits 0, once a real file chooser is open.
  await view.evaluate(() => {
    window.inputClicks = [];
    HTMLInputElement.prototype.click = function () { window.inputClicks.push({ id: this.id, type: this.type, accept: this.accept, active: navigator.userActivation.isActive }); };
  });
  await view.click('#open-archimate-choose');
  const inputClicks = await view.evaluate(() => window.inputClicks);
  assert(inputClicks.length === 1 && inputClicks[0].id === 'open-archimate-file' && inputClicks[0].type === 'file' &&
    inputClicks[0].accept === '.archimate,.xml' && inputClicks[0].active,
    `Choose a file… did not click the file input with the person's activation: ${JSON.stringify(inputClicks)}.`);
  // The file the picker would hand over, set on the input as the picker sets it.
  await view.evaluate(text => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], 'Archisurance.archimate', { type: 'application/xml' }));
    const input = document.getElementById('open-archimate-file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, savedXml);
  await until(() => !document.getElementById('open-archimate-open').disabled &&
    /^Archisurance: 120 elements, 176 relationships, 17 views\.$/.test(document.getElementById('open-archimate-summary').textContent), null,
    'The chosen file did not say what it holds.');
  await view.click('#open-archimate-open');
  try {
    await view.waitForFunction(() => /^Opened Archisurance\.archimate: 120 elements, 176 relationships, 17 views\.$/.test(document.getElementById('status').textContent), null, { timeout: 20000, polling: 100 });
  } catch { throw new Error('Open did not finish with Archisurance opened. The view says: ' + JSON.stringify(await status())); }
  const openSaves = (await page.evaluate(() => window.broker.requests.filter(request => request.m === 'records.batch').map(request => ({ label: request.p.label ?? null, writes: request.p.writes.length })))).slice(savesBefore);
  assert(openSaves.length === 4 && openSaves.every((batch, index) => batch.writes <= 200 && batch.label === `Open Archisurance.archimate (${index + 1} of 4)`),
    `The model was not saved in four labelled batches of at most 200: ${JSON.stringify(openSaves)}.`);
  // The records are the fixture's, value for value; the Model record is the new model's own.
  const plain = values => JSON.stringify(Object.entries(values).filter(([, value]) => value !== null).sort(([a], [b]) => (a < b ? -1 : 1)));
  const openedRecords = {};
  for (const entityId of ['ar.concept', 'ar.view', 'ar.item', 'ar.specialization', 'ar.folder', 'ar.property']) {
    const want = new Map((fixture.records[entityId] ?? []).map(record => [record.recordId, plain(record.values)]));
    const got = await records(entityId);
    const differing = got.filter(record => want.get(record.recordId) !== plain(record.values)).map(record => record.recordId);
    assert(got.length === want.size && differing.length === 0,
      `${entityId}: ${got.length} records, not ${want.size}; ${differing.length} differ from Archisurance's, first ${JSON.stringify(differing.slice(0, 3))}.`);
    openedRecords[entityId] = got.length;
  }
  const newModel = (await records('ar.model'))[0];
  assert((await records('ar.model')).length === 1 && newModel.values['ar.model.name'] === 'Archisurance',
    'The new model did not take Archisurance\u2019s name, or a second Model record was made.');
  assert((await rows())[0].label === 'Archisurance', 'The tree does not start at the opened model.');
  results.openArchimate = { batches: openSaves.map(batch => batch.writes), records: openedRecords };

  assert(errors.length === 0, `The page reported errors: ${errors.join(' | ')}`);
  // Review-ArchiWorkbench.ps1 requires this: the CLI ends a probe early, exit code 0, when a native
  // dialog or file chooser opens, so only the probe's own last word says it measured everything.
  results.complete = true;
  return JSON.stringify(results);
}
