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
  const actorAt = await boxOf(actorBox);
  await page.mouse.click(editFrame.x + actorAt.x + actorAt.width / 2, editFrame.y + actorAt.y + actorAt.height / 2);
  await page.keyboard.press('Delete');
  await pendingIs(2, 'The new box deleted from the view: the box and the line drawn to it');
  await page.evaluate(() => window.broker.command('discard', null, 'toolbar'));
  await pendingIs(0, 'Discarded');
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
  const cycleFixture = structuredClone(fixture);
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

  assert(errors.length === 0, `The page reported errors: ${errors.join(' | ')}`);
  return JSON.stringify(results);
}
