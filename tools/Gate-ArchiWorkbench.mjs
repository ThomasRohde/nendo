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
  const stepTo = declared.findIndex(entry => !entry.replace && entry.place.view === smallest.recordId);
  assert(stepTo > 0, `Opening a second view was not a step: ${JSON.stringify(declared.slice(0, 8))}.`);
  assert(declared[stepTo].label === smallest.values['ar.view.name'], `The step does not carry the view's name for the Back button: ${JSON.stringify(declared[stepTo])}.`);
  const leftAt = declared.slice(0, stepTo).filter(entry => entry.place.view === opened.recordId).at(-1)?.place;
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

  assert(errors.length === 0, `The page reported errors: ${errors.join(' | ')}`);
  return JSON.stringify(results);
}
