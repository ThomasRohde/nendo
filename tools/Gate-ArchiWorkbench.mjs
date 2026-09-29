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
  await page.evaluate(() => { window.broker.offerWrites(true); window.broker.offerChrome(true); });
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
  assert((await selected())?.id === created.recordId, 'The new element is not selected.');
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
  await page.evaluate(() => window.broker.command('find', '', 'toolbar'));

  // Every declaration the workbench made so far was one Nendo draws.
  const refusals = await page.evaluate(() => window.broker.chromeRefusals);
  assert(refusals.length === 0, `Nendo's rules refused the workbench's controls: ${JSON.stringify(refusals)}.`);
  assert(await view.evaluate(() => getComputedStyle(document.getElementById('own-toolbar')).display === 'none'), 'The workbench fell back to its own toolbar.');

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

  assert(errors.length === 0, `The page reported errors: ${errors.join(' | ')}`);
  return JSON.stringify(results);
}
