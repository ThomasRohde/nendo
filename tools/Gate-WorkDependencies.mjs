async (page) => {
  const root = '__NENDO_REPOSITORY__';
  const errors = [];
  // Errors in the view's own frame reach the page too, uncaught rejections included.
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  await page.setViewportSize({ width: 1024, height: 700 });
  // The broker page frames the package from another origin and answers it as the Workbench would.
  await page.goto('__BROKER_URL__');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => window.broker.viewOrigin);

  // The planner's shape: work items with a title and a Status whose option IDs are not their
  // names, and dependency records whose two references point at work items.
  const field = (fieldId, displayName, storageKind, extra = {}) => ({ fieldId, displayName, storageKind, required: false,
    presentation: null, calculated: false, expression: null, choices: [], reference: null, scale: null, ...extra });
  const record = (entityId, recordId, values, labels = {}) => ({ entityId, recordId, version: 1, values, exact: {}, labels, calculated: {} });
  const statuses = ['Inbox', 'Ready', 'Doing', 'Blocked', 'Review', 'Done', 'Dropped'];
  const initiatives = { i1: 'Release', i2: 'Cycle work' };
  const fixture = ({ nodes, edges }) => {
    const names = new Map(nodes.map(node => [node.id, node.label]));
    return {
      context: { viewId: 'workDependencies', kind: 'extensionGraphSurface', placement: 'screen', title: 'Work dependencies', entityId: 'workItem', recordId: null,
        bindings: { labelFieldId: 'workTitle', statusFieldId: 'workStatus', edgeEntityId: 'workDependency', sourceFieldId: 'dependencyBlocker',
          targetFieldId: 'dependencyBlocked', fields: [], filters: [] } },
      schema: { entities: [
        { entityId: 'workItem', displayName: 'Work item', fields: [field('workTitle', 'Title', 'text'), field('workStatus', 'Status', 'text', { presentation: 'singleChoice',
          choices: statuses.map(name => ({ id: 'status-' + name.toLowerCase(), displayName: name, retired: false, tone: null })) }),
          field('workInitiative', 'Initiative', 'reference', { reference: { targetEntityId: 'initiative', labelFieldId: 'initiativeName' } })] },
        { entityId: 'initiative', displayName: 'Initiative', fields: [field('initiativeName', 'Name', 'text')] },
        { entityId: 'workDependency', displayName: 'Dependency', fields: [
          field('dependencyBlocker', 'Blocker', 'reference', { reference: { targetEntityId: 'workItem', labelFieldId: 'workTitle' } }),
          field('dependencyBlocked', 'Blocked', 'reference', { reference: { targetEntityId: 'workItem', labelFieldId: 'workTitle' } })] },
      ] },
      records: {
        workItem: nodes.map(node => record('workItem', node.id, { workTitle: node.label, workStatus: node.status ? 'status-' + node.status.toLowerCase() : null,
          workInitiative: node.initiative ?? null }, node.initiative ? { workInitiative: initiatives[node.initiative] } : {})),
        workDependency: edges.map(edge => record('workDependency', edge.id, { dependencyBlocker: edge.sourceId, dependencyBlocked: edge.targetId },
          { dependencyBlocker: names.get(edge.sourceId) ?? null, dependencyBlocked: names.get(edge.targetId) ?? null })),
      },
    };
  };

  let view = null;
  const frameOf = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const frame = page.frames().find(candidate => candidate.url().startsWith(origin + '/'));
      if (frame !== undefined) { await frame.waitForSelector('#summary'); return frame; }
      await page.waitForTimeout(25);
    }
    throw new Error('The view never loaded from its own origin.');
  };
  const summary = () => view.locator('#summary').innerText();
  const until = async (predicate, arg, message) => {
    try { await view.waitForFunction(predicate, arg, { timeout: 5000, polling: 50 }); } catch {
      throw new Error(message + ' The view says: ' + JSON.stringify(await view.evaluate(() => document.getElementById('summary').textContent)));
    }
  };
  const requests = (from = 0) => page.evaluate(start => window.broker.requests.slice(start), from);
  const requestCount = () => page.evaluate(() => window.broker.requests.length);
  const openCount = () => page.evaluate(() => window.broker.opened().length);
  // What one action asked Nendo to open: wait for the first request, then long enough for a second.
  const opens = async action => {
    const before = await openCount();
    await action();
    await page.waitForFunction(count => window.broker.opened().length > count, before, { timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    return page.evaluate(count => window.broker.opened().slice(count), before);
  };
  const exactlyOne = (list, recordId, message) =>
    assert(list.length === 1 && list[0].entityId === 'workItem' && list[0].recordId === recordId && Object.keys(list[0]).sort().join() === 'entityId,recordId',
      message + ' ' + JSON.stringify(list));
  // The file changes and Nendo says so: the view shows what it then reads.
  const replace = async (next, expected) => {
    await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, next);
    await until(text => document.getElementById('summary').textContent === text, expected, `The view never showed "${expected}" after the file changed.`);
  };

  // A chain, an isolated item, a three-item cycle, one item standing behind that cycle, a
  // duplicate link and a label that looks like markup. Every claim the view makes is about
  // one of these shapes.
  const projection = { nodes: [
    { id: 'a', label: 'Accept the amendment', status: 'Done', initiative: 'i1' },
    { id: 'b', label: 'Build the isolated helper', status: 'Doing', initiative: 'i1' },
    { id: 'c', label: 'Qualify the release', status: 'Ready', initiative: 'i1' },
    { id: 'd', label: 'Write the authoring guide', status: null },
    { id: 'x', label: '<img src=x onerror=alert(1)>', status: 'Blocked', initiative: 'i2' },
    { id: 'y', label: 'Second of the cycle', status: 'Blocked', initiative: 'i2' },
    { id: 'z', label: 'Third of the cycle', status: 'Review', initiative: 'i2' },
    { id: 'w', label: 'Behind the cycle', status: 'Inbox', initiative: 'i2' },
  ], edges: [
    { id: 'e1', sourceId: 'a', targetId: 'b' }, { id: 'e2', sourceId: 'a', targetId: 'b' },
    { id: 'e3', sourceId: 'b', targetId: 'c' },
    { id: 'e4', sourceId: 'x', targetId: 'y' }, { id: 'e5', sourceId: 'y', targetId: 'z' },
    { id: 'e6', sourceId: 'z', targetId: 'x' }, { id: 'e7', sourceId: 'z', targetId: 'w' },
  ] };
  await page.evaluate(value => window.broker.setFixture(value), fixture(projection));
  view = await frameOf();
  await until(() => document.querySelectorAll('.node').length > 0, undefined, 'The view never drew its work items.');

  // One hello and one connect, at the API version protocol.ts declares: the handshake is api.js's.
  const handshake = await page.evaluate(() => ({ connects: window.broker.connects, hellos: [...window.broker.hellos], apiVersion: window.broker.apiVersion }));
  assert(handshake.connects === 1 && JSON.stringify(handshake.hellos) === JSON.stringify([handshake.apiVersion]),
    'The view did not connect exactly once at the API version protocol.ts declares: ' + JSON.stringify(handshake));
  assert(await view.locator('.node').count() === 8, 'The view omitted a work item.');
  assert(await view.locator('.edge').count() === 7, 'The view omitted a link, a duplicate or a cycle edge.');
  assert(await view.locator('img').count() === 0, 'A work item label became markup.');
  assert(await summary() === '8 work items · 7 links · 2 unblocked · 3 in a dependency cycle', 'The summary is wrong: ' + await summary());

  // The layout is the claim: left to right is the order the work has to happen in. Every link
  // that is not part of a cycle must point at a column strictly further right.
  const columns = await view.evaluate(() => Object.fromEntries([...document.querySelectorAll('.node')]
    .map(node => [node.dataset.id, Number(/translate\(([-0-9.]+)/.exec(node.getAttribute('transform'))[1])])));
  for (const [from, to] of [['a', 'b'], ['b', 'c'], ['z', 'w']])
    assert(columns[to] > columns[from], `${from} does not sit left of ${to}: ` + JSON.stringify(columns));

  // Tarjan, not "whatever the ordering pass could not settle": the three items in the cycle are
  // marked and the item merely standing behind it is not.
  const marked = await view.evaluate(() => [...document.querySelectorAll('.node')]
    .filter(node => [...node.querySelectorAll('text')].some(text => text.textContent === 'cycle')).map(node => node.dataset.id).sort());
  assert(JSON.stringify(marked) === JSON.stringify(['x', 'y', 'z']), 'The cycle is marked wrongly: ' + JSON.stringify(marked));
  const cycleEdges = await view.evaluate(() => [...document.querySelectorAll('.edge.cycle')].map(edge => edge.dataset.edgeId).sort());
  assert(JSON.stringify(cycleEdges) === JSON.stringify(['e4', 'e5', 'e6']), 'The cycle edges are drawn wrongly: ' + JSON.stringify(cycleEdges));

  // The Status is stored as its option ID and read by its name: the name is shown, and the tone
  // is the planner's tone for that name.
  const tones = await view.evaluate(() => Object.fromEntries(['a', 'b', 'd'].map(id => {
    const node = document.querySelector(`.node[data-id="${id}"]`);
    return [id, { status: node.querySelector('.status')?.textContent ?? null, tone: node.querySelector('.tone')?.getAttribute('class') ?? null }];
  })));
  assert(tones.a.status === 'Done' && tones.a.tone === 'tone tone-green' && tones.b.status === 'Doing' && tones.b.tone === 'tone tone-violet' &&
    tones.d.status === null && tones.d.tone === null, 'A status is not shown by its choice name and tone: ' + JSON.stringify(tones));

  // Nodes must open inside the visible canvas: a fit against a not-yet-sized canvas puts every
  // item off-screen and the view looks empty (owner-reported on the graph package, F-114).
  const inView = await view.evaluate(() => {
    const bounds = document.getElementById('canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.node')].map(node => {
      const r = node.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return cx >= bounds.x && cx <= bounds.x + bounds.width && cy >= bounds.y && cy <= bounds.y + bounds.height;
    });
  });
  assert(inView.length === 8 && inView.every(Boolean), 'A work item opened outside the visible canvas: ' + JSON.stringify(inView));

  // The layout is ELK's, and it is measured rather than looked at: every link runs at right
  // angles from the blocker's edge to the blocked item's edge, no two items overlap, and an item
  // linked to nothing waits on the shelf below the drawing instead of stretching it.
  const geometry = () => view.evaluate(() => {
    const nodes = Object.fromEntries([...document.querySelectorAll('.node')].map(node => {
      const [, x, y] = /translate\(([-0-9.]+) ([-0-9.]+)\)/.exec(node.getAttribute('transform'));
      const rect = node.querySelector('rect');
      return [node.dataset.id, { x: +x, y: +y, width: +rect.getAttribute('width'), height: +rect.getAttribute('height'), unlinked: node.classList.contains('unlinked') }];
    }));
    const edges = [...document.querySelectorAll('.edge')].map(edge => ({ id: edge.dataset.edgeId, source: edge.dataset.source, target: edge.dataset.target,
      points: [...edge.getAttribute('d').matchAll(/[ML] ([-0-9.]+) ([-0-9.]+)/g)].map(match => ({ x: +match[1], y: +match[2] })) }));
    const groups = [...document.querySelectorAll('.group')].map(group => {
      const rect = group.querySelector('rect');
      return { key: group.dataset.group, part: group.classList.contains('shelf') ? 'shelf' : 'diagram', title: group.querySelector('.group-title').textContent,
        x: +rect.getAttribute('x'), y: +rect.getAttribute('y'), width: +rect.getAttribute('width'), height: +rect.getAttribute('height') };
    });
    return { layout: document.documentElement.dataset.layout, nodes, edges, groups };
  });
  const onBorder = (point, box) => {
    const within = (value, low, high) => value >= low - 1.5 && value <= high + 1.5, near = (value, target) => Math.abs(value - target) <= 1.5;
    return within(point.x, box.x, box.x + box.width) && (near(point.y, box.y) || near(point.y, box.y + box.height)) ||
      within(point.y, box.y, box.y + box.height) && (near(point.x, box.x) || near(point.x, box.x + box.width));
  };
  const inside = (box, frame) => box.x >= frame.x - .5 && box.y >= frame.y - .5 && box.x + box.width <= frame.x + frame.width + .5 && box.y + box.height <= frame.y + frame.height + .5;
  const checkDrawing = (drawn, label) => {
    assert(drawn.layout === 'elk', `${label}: the drawing was not laid out by ELK; it says "${drawn.layout}".`);
    for (const edge of drawn.edges) {
      assert(edge.points.length >= 2, `${label}: link ${edge.id} has no route.`);
      for (let at = 1; at < edge.points.length; at += 1) {
        const from = edge.points[at - 1], to = edge.points[at];
        assert(Math.abs(from.x - to.x) < .6 || Math.abs(from.y - to.y) < .6, `${label}: link ${edge.id} has a slanted segment: ` + JSON.stringify(edge.points));
      }
      assert(onBorder(edge.points[0], drawn.nodes[edge.source]) && onBorder(edge.points.at(-1), drawn.nodes[edge.target]),
        `${label}: link ${edge.id} does not run from its blocker's edge to the blocked item's edge: ` + JSON.stringify({ route: edge.points, from: drawn.nodes[edge.source], to: drawn.nodes[edge.target] }));
    }
    const ids = Object.keys(drawn.nodes);
    for (let first = 0; first < ids.length; first += 1) for (let second = first + 1; second < ids.length; second += 1) {
      const a = drawn.nodes[ids[first]], b = drawn.nodes[ids[second]];
      assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${label}: ${ids[first]} and ${ids[second]} overlap: ` + JSON.stringify({ a, b }));
    }
  };
  const plain = await geometry();
  checkDrawing(plain, 'Ungrouped');
  const linkedBottom = Math.max(...Object.values(plain.nodes).filter(box => !box.unlinked).map(box => box.y + box.height));
  assert(plain.nodes.d.unlinked && plain.nodes.d.y > linkedBottom + 20 && Object.values(plain.nodes).filter(box => box.unlinked).length === 1,
    'The item linked to nothing is not on the shelf below the drawing: ' + JSON.stringify(plain.nodes));

  // Grouped by a reference: each group is a box that holds exactly its own items, and links
  // still run at right angles between boxes.
  await view.locator('#group-by').selectOption('workInitiative');
  await until(() => document.querySelectorAll('.group.diagram').length === 2, undefined, 'Grouping by initiative did not draw a box for each initiative.');
  const grouped = await geometry();
  checkDrawing(grouped, 'Grouped');
  const box = key => grouped.groups.find(group => group.key === key);
  assert(box('i1')?.title === 'Release · 3' && box('i2')?.title === 'Cycle work · 4' && box('')?.part === 'shelf' && box('')?.title === 'No initiative · 1',
    'The groups are not titled by their initiatives and counts: ' + JSON.stringify(grouped.groups));
  for (const [id, key] of Object.entries({ a: 'i1', b: 'i1', c: 'i1', x: 'i2', y: 'i2', z: 'i2', w: 'i2', d: '' }))
    assert(inside(grouped.nodes[id], box(key)), `${id} is not inside its group's box: ` + JSON.stringify({ node: grouped.nodes[id], group: box(key) }));
  assert(await summary() === '8 work items · 7 links · 2 unblocked · 3 in a dependency cycle', 'Grouping changed what the summary counts: ' + await summary());
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/work-dependencies-grouped.png' });

  // The choice is kept on this device: the view comes back grouped after a reload.
  await view.evaluate(() => { setTimeout(() => location.reload(), 0); });
  await page.waitForTimeout(300);
  await until(() => document.querySelectorAll('.group.diagram').length === 2 && document.getElementById('group-by').value === 'workInitiative', undefined,
    'The grouping was not remembered across a reload.');
  await view.locator('#group-by').selectOption('');
  await until(() => document.querySelectorAll('.group').length === 0, undefined, 'Grouping by nothing left a group box drawn.');

  // Filter hides a status, with its links; Linked only takes the shelf away. Both say so.
  await view.getByRole('button', { name: 'Filter', exact: true }).click();
  await view.locator('#status-chips input[data-status="status-done"]').uncheck();
  await until(() => document.getElementById('summary').textContent === '7 work items · 5 links · 2 unblocked · 3 in a dependency cycle · 1 hidden', undefined,
    'Hiding Done did not take the done item and its links away, and say so.');
  assert(await view.locator('.node[data-id="a"]').count() === 0, 'A hidden status is still drawn.');
  await view.locator('#status-chips input[data-status="status-done"]').check();
  await view.getByRole('button', { name: 'Linked only', exact: true }).click();
  await until(() => document.getElementById('summary').textContent === '7 work items · 7 links · 1 unblocked · 3 in a dependency cycle · 1 hidden', undefined,
    'Linked only did not take away the item linked to nothing, and say so.');
  await view.getByRole('button', { name: 'Linked only', exact: true }).click();
  await until(() => document.getElementById('summary').textContent === '8 work items · 7 links · 2 unblocked · 3 in a dependency cycle', undefined,
    'Showing everything again did not bring the item back.');
  await view.locator('#filter-toggle').click();

  // Longest chain marks the longest run of work that has to happen in order, cycle links set aside.
  await view.getByRole('button', { name: 'Longest chain', exact: true }).click();
  const chained = await view.evaluate(() => ({ nodes: [...document.querySelectorAll('.node.chain')].map(node => node.dataset.id).sort(),
    edges: [...document.querySelectorAll('.edge.chain')].map(edge => edge.dataset.edgeId).sort(), line: document.getElementById('selection').textContent }));
  assert(JSON.stringify(chained.nodes) === JSON.stringify(['a', 'b', 'c']) && JSON.stringify(chained.edges) === JSON.stringify(['e1', 'e2', 'e3']),
    'Longest chain marked the wrong items or links: ' + JSON.stringify(chained));
  assert(chained.line === 'Longest chain: Accept the amendment → Build the isolated helper → Qualify the release · 3 items', 'The chain is not named: ' + chained.line);
  await view.getByRole('button', { name: 'Longest chain', exact: true }).click();

  // Find dims what does not match, and Enter opens the first match, once.
  await view.locator('#find').fill('cycle');
  const matches = await view.evaluate(() => [...document.querySelectorAll('.node.match')].map(node => node.dataset.id).sort());
  assert(JSON.stringify(matches) === JSON.stringify(['w', 'y', 'z']), 'Find matched the wrong items: ' + JSON.stringify(matches));
  exactlyOne(await opens(() => view.locator('#find').press('Enter')), 'y', 'Enter in Find did not open the first match, once:');
  await view.locator('#find').press('Escape');
  assert(await view.locator('.node.match').count() === 0, 'Escape did not clear Find.');

  // Selecting an item asks Nendo to open it: once, by its record type and ID.
  exactlyOne(await opens(() => view.locator('.node[data-id="b"]').click()), 'b', 'Selecting an item did not ask Nendo to open exactly that item, once:');
  // Two link records both saying a blocks b are two links and one blocker.
  assert(await view.locator('#selection').innerText() === 'Build the isolated helper · blocked by 1 · blocks 1',
    'The selection line is wrong: ' + await view.locator('#selection').innerText());

  // Focus answers "what is connected to this" by taking the rest out of the way.
  await view.getByRole('button', { name: 'Focus', exact: true }).click();
  const opacity = await view.evaluate(() => Object.fromEntries(['a', 'b', 'c', 'd', 'x']
    .map(id => [id, Number(getComputedStyle(document.querySelector(`.node[data-id="${id}"]`)).opacity)])));
  assert(opacity.a === 1 && opacity.b === 1 && opacity.c === 1, 'Focus faded something connected: ' + JSON.stringify(opacity));
  assert(opacity.d < .3 && opacity.x < .3, 'Focus left an unconnected item undimmed: ' + JSON.stringify(opacity));
  await view.getByRole('button', { name: 'Focus', exact: true }).click();
  assert(Number(await view.evaluate(() => getComputedStyle(document.querySelector('.node[data-id="d"]')).opacity)) === 1,
    'Leaving focus did not restore the view.');

  await view.locator('.node[data-id="a"]').focus();
  exactlyOne(await opens(async () => { await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); }), 'b',
    'Keyboard traversal opened the wrong item, or not once:');

  const before = await view.locator('#drawing').getAttribute('transform');
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert(await view.locator('#drawing').getAttribute('transform') !== before, 'Zoom did not change the transform.');
  await view.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/work-dependencies-light.png' });
  // A refusal to open is said in the view, as text, and not thrown.
  await page.evaluate(() => window.broker.fail('ui.openRecord', { code: 'not-allowed', message: 'A record page has unsaved changes, so Nendo stays where it is until they are saved or closed.' }));
  await view.locator('.node[data-id="d"]').click();
  await until(() => document.getElementById('selection').textContent.includes('unsaved changes'), undefined, 'A refused open was not shown as text in the view.');

  // The text alternative carries the same relationships for a dense graph or a screen reader.
  await view.getByRole('button', { name: 'Text view', exact: true }).click();
  const rows = await view.evaluate(() => [...document.querySelectorAll('#records li')].map(row => row.innerText.replace(/\s+/g, ' ')));
  assert(rows.length === 8, 'The text alternative omitted a work item.');
  assert(rows.some(row => row.includes('Doing · Blocked by: Accept the amendment. Blocks: Qualify the release.')),
    'The text alternative does not say what blocks what: ' + JSON.stringify(rows.slice(0, 3)));
  assert(rows.some(row => row.includes('In a dependency cycle.')), 'The text alternative never mentions the cycle.');
  exactlyOne(await opens(() => view.locator('#records button').nth(2).click()), 'c', 'The text alternative opened the wrong item, or not once:');
  await view.getByRole('button', { name: 'Graph view', exact: true }).click();

  // The gate cannot drive a real text selection in WebView2, so it measures the computed rule.
  const selectable = await view.evaluate(() => Object.fromEntries(['header', '#canvas', '#summary', 'footer', '#text-view']
    .map(s => [s, getComputedStyle(document.querySelector(s)).userSelect])));
  assert(['header', '#canvas', '#summary', 'footer'].every(s => selectable[s] === 'none'), 'View chrome is text-selectable: ' + JSON.stringify(selectable));
  assert(selectable['#text-view'] !== 'none', 'The text alternative must stay selectable: ' + JSON.stringify(selectable));

  // The file changes. The view reads again only when Nendo says so, keeps the selected item
  // selected without opening it again, and shows what changed.
  exactlyOne(await opens(() => view.locator('.node[data-id="b"]').click()), 'b', 'Selecting an item did not open it once:');
  const opened = await openCount();
  let mark = await requestCount();
  await page.evaluate(value => window.broker.setFixture(value), fixture({
    nodes: projection.nodes.map(node => node.id === 'c' ? { ...node, label: 'Qualify the second release', status: 'Doing' } : node),
    edges: [...projection.edges, { id: 'e8', sourceId: 'd', targetId: 'b' }] }));
  await page.waitForTimeout(400);
  const early = await requests(mark);
  assert(early.length === 0, 'The view read the file before Nendo said it changed: ' + JSON.stringify(early.map(r => r.m)));
  const heard = await page.evaluate(() => { window.broker.pushChanges(); return window.broker.events.at(-1); });
  await until(() => document.getElementById('summary').textContent === '8 work items · 8 links · 2 unblocked · 3 in a dependency cycle', undefined,
    'The view did not read again and show the change after Nendo said the file changed.');
  const reread = await requests(mark);
  assert(reread.some(r => r.m === 'records.query'), 'The view showed a change without reading the records again: ' + JSON.stringify(reread.map(r => r.m)));
  assert(reread[0].t - heard.t >= 150, `The view read again ${reread[0].t - heard.t} ms after the change, not about a quarter of a second.`);
  assert(await view.locator('.node[data-id="c"] title').textContent() === 'Qualify the second release — Doing', 'The changed item is not drawn as it now is.');
  assert(await view.locator('.node[data-id="b"]').getAttribute('aria-pressed') === 'true' &&
    await view.locator('#selection').innerText() === 'Build the isolated helper · blocked by 2 · blocks 1', 'The re-read lost the selection, or kept a stale line: ' +
    await view.locator('#selection').innerText());
  assert(await openCount() === opened, 'The re-read opened the selected item again.');
  mark = await requestCount();
  await page.evaluate(() => { for (let index = 0; index < 5; index += 1) window.broker.pushChanges(); });
  await page.waitForTimeout(900);
  const burst = (await requests(mark)).filter(r => r.m === 'records.query' && r.p.entityId === 'workItem' && (r.p.cursor ?? null) === null).length;
  assert(burst === 1, `A burst of five changes made ${burst} reads of the work items, not one.`);

  // A re-read that no longer has the selected item drops the selection; the counts are exact,
  // singular included.
  await replace(fixture({ nodes: [{ id: 'p', label: 'First', status: 'Doing' }, { id: 'q', label: 'Second', status: null }],
    edges: [{ id: 'e1', sourceId: 'p', targetId: 'q' }] }), '2 work items · 1 link · 1 unblocked');
  assert(await view.locator('#selection').innerText() === 'No work item selected', 'Replacement kept a stale selection.');

  // The Workbench's dark theme arrives as an event, and the view's colours follow it.
  const lightColour = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => window.broker.pushTheme('dark'));
  await until(colour => getComputedStyle(document.body).backgroundColor !== colour, lightColour, 'A dark theme event did not change the view\'s colours.');
  assert(await view.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'The theme event was ignored.');
  const darkColour = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/work-dependencies-dark.png' });

  // An empty file says so rather than drawing nothing.
  await replace(fixture({ nodes: [], edges: [] }), '0 work items · 0 links');
  assert(await view.locator('#empty').isVisible(), 'An empty file drew nothing and said nothing.');

  // A refused read is said in the view, as text, and the next change reads again.
  await page.evaluate(() => {
    window.broker.fail('records.query', { code: 'views-off', message: 'Custom views are off, so this view cannot read the file.' });
    window.broker.pushChanges();
  });
  await until(() => document.getElementById('summary').textContent.includes('Custom views are off'), undefined, 'A refused read was not shown as text in the view.');

  // The pane is half a window and can be small: 512x384 is a 1024x768 window at 200% scaling.
  await replace(fixture(projection), '8 work items · 7 links · 2 unblocked · 3 in a dependency cycle');
  await page.setViewportSize({ width: 512, height: 384 });
  await page.waitForTimeout(150);
  const compact = await view.evaluate(() => {
    const names = ['find', 'group-by', 'filter-toggle', 'linked-toggle', 'chain-toggle', 'zoom-out', 'reset', 'zoom-in', 'focus-toggle', 'text-toggle'];
    const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    return { overflow, controls: names.map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    }) };
  });
  assert(!compact.overflow, 'The view overflows horizontally at 512x384.');
  assert(compact.controls.every(Boolean), 'A control left the window at 512x384: ' + JSON.stringify(compact.controls));

  const methods = [...new Set((await requests()).map(r => r.m))].sort();
  assert(JSON.stringify(methods) === JSON.stringify(['records.query', 'schema.describe', 'ui.openRecord']),
    'The view asked for something other than reads and opening a record: ' + JSON.stringify(methods));
  assert(errors.length === 0, 'The view raised: ' + errors.join(' | '));
  return 'work dependencies ok ' + JSON.stringify({ themes: { light: lightColour, dark: darkColour }, burstReads: burst, layout: plain.layout,
    extent: { plain: Object.keys(plain.nodes).length, grouped: grouped.groups.length } });
}
