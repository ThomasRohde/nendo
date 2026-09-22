(() => {
  'use strict';
  const element = id => document.getElementById(id);
  const drawing = element('drawing'), canvas = element('canvas');
  let session = null, generation = 0, nodes = [], edges = [], selected = null, focusing = false;
  let width = 800, height = 500, scale = 1, offsetX = 0, offsetY = 0, drag = null;
  const positions = new Map();     // node id -> {x, y}
  const component = new Map();     // node id -> strongly connected component index
  const cyclic = new Set();        // node ids that sit in a real cycle
  const outgoing = new Map();      // node id -> [node id]
  const incoming = new Map();      // node id -> [node id]
  const NODE_WIDTH = 210, NODE_HEIGHT = 64, COLUMN = 262, ROW = 96;
  // The planner's own Status choices, in its own tones. An unknown status is drawn neutral
  // rather than guessed at, so this package stays usable against another file's scalar.
  const TONES = { inbox: 'grey', ready: 'blue', doing: 'violet', blocked: 'red', review: 'amber', done: 'green', dropped: 'grey' };

  function send(method, values = {}) {
    if (session !== null) window.chrome.webview.postMessage({ version: 1, session, generation, method, ...values });
  }
  function shape(name, attributes, text) {
    const item = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function transform() { drawing.setAttribute('transform', `translate(${offsetX} ${offsetY}) scale(${scale})`); }
  function fit() {
    const bounds = canvas.getBoundingClientRect();
    // The host composes and sizes this pane after the page loads, so an early fit can measure
    // zero and put every item off-screen. Skip until the canvas has a real size.
    if (bounds.width < 1 || bounds.height < 1) return;
    scale = Math.min(1.1, Math.max(.08, Math.min(bounds.width / width, bounds.height / height) * .92));
    offsetX = (bounds.width - width * scale) / 2; offsetY = (bounds.height - height * scale) / 2;
    transform();
  }
  function refit() { requestAnimationFrame(() => requestAnimationFrame(() => { if (session !== null && !canvas.hidden) fit(); })); }
  window.addEventListener('resize', () => { if (session !== null && !canvas.hidden) fit(); });
  function zoom(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    const next = Math.min(4, Math.max(.08, scale * factor));
    offsetX = x - (x - offsetX) * next / scale; offsetY = y - (y - offsetY) * next / scale;
    scale = next; transform();
  }

  /**
   * Tarjan's strongly connected components, so a cycle is named exactly rather than inferred
   * from "whatever the topological pass could not settle" -- which also catches everything
   * merely standing behind a cycle. Iterative: a planner chain can be deep and this runs
   * inside a contained renderer with no stack to spare.
   */
  function components() {
    component.clear(); cyclic.clear();
    const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
    let next = 0, group = 0;
    for (const root of nodes) {
      if (index.has(root.id)) continue;
      const work = [{ id: root.id, child: 0 }];
      while (work.length !== 0) {
        const frame = work[work.length - 1];
        if (frame.child === 0) {
          index.set(frame.id, next); low.set(frame.id, next); next += 1;
          stack.push(frame.id); onStack.add(frame.id);
        }
        const children = outgoing.get(frame.id);
        if (frame.child < children.length) {
          const child = children[frame.child]; frame.child += 1;
          if (!index.has(child)) work.push({ id: child, child: 0 });
          else if (onStack.has(child)) low.set(frame.id, Math.min(low.get(frame.id), index.get(child)));
          continue;
        }
        if (low.get(frame.id) === index.get(frame.id)) {
          const members = [];
          for (;;) {
            const id = stack.pop(); onStack.delete(id); members.push(id);
            component.set(id, group);
            if (id === frame.id) break;
          }
          // One member is a cycle only when it links to itself; two or more always are.
          if (members.length > 1 || outgoing.get(frame.id).includes(frame.id)) for (const id of members) cyclic.add(id);
          group += 1;
        }
        work.pop();
        if (work.length !== 0) {
          const parent = work[work.length - 1];
          low.set(parent.id, Math.min(low.get(parent.id), low.get(frame.id)));
        }
      }
    }
  }

  /**
   * Longest-path layering: an item sits one column to the right of the last thing that blocks
   * it, so reading left to right is reading the order the work has to happen in. Edges inside
   * one component are left out of the ordering -- they are the cycle, and keeping them would
   * mean no ordering exists at all.
   */
  function layout() {
    positions.clear();
    const degree = new Map(nodes.map(node => [node.id, 0]));
    const forward = new Map(nodes.map(node => [node.id, []]));
    for (const edge of edges) {
      if (edge.sourceId === edge.targetId || component.get(edge.sourceId) === component.get(edge.targetId)) continue;
      forward.get(edge.sourceId).push(edge.targetId);
      degree.set(edge.targetId, degree.get(edge.targetId) + 1);
    }
    const layer = new Map(nodes.map(node => [node.id, 0]));
    const queue = nodes.filter(node => degree.get(node.id) === 0).map(node => node.id);
    for (let at = 0; at < queue.length; at += 1) {
      const id = queue[at];
      for (const target of forward.get(id)) {
        layer.set(target, Math.max(layer.get(target), layer.get(id) + 1));
        degree.set(target, degree.get(target) - 1);
        if (degree.get(target) === 0) queue.push(target);
      }
    }
    const columns = new Map();
    for (const node of nodes) {
      const at = layer.get(node.id);
      const column = columns.get(at) ?? [];
      column.push(node); columns.set(at, column);
    }
    let rows = 1;
    for (const [at, column] of columns) {
      rows = Math.max(rows, column.length);
      column.forEach((node, row) => positions.set(node.id, { x: 40 + at * COLUMN, y: 40 + row * ROW }));
    }
    width = Math.max(320, (Math.max(...columns.keys()) + 1) * COLUMN + 40);
    height = Math.max(240, rows * ROW + 40);
  }

  function reachable(from, map) {
    const seen = new Set(), queue = [from];
    while (queue.length !== 0) {
      for (const next of map.get(queue.pop()) ?? []) if (!seen.has(next) && next !== from) { seen.add(next); queue.push(next); }
    }
    return seen;
  }

  function paint() {
    const blockers = selected === null ? new Set() : reachable(selected, incoming);
    const blocked = selected === null ? new Set() : reachable(selected, outgoing);
    const connected = new Set([...blockers, ...blocked]);
    if (selected !== null) connected.add(selected);
    drawing.classList.toggle('focused', focusing && selected !== null);
    for (const node of drawing.querySelectorAll('.node')) {
      const id = node.dataset.id;
      node.classList.toggle('selected', id === selected);
      node.classList.toggle('upstream', blockers.has(id));
      node.classList.toggle('downstream', blocked.has(id));
      node.classList.toggle('faded', selected !== null && !connected.has(id));
      node.setAttribute('aria-pressed', String(id === selected));
    }
    for (const edge of drawing.querySelectorAll('.edge')) {
      const touches = connected.has(edge.dataset.source) && connected.has(edge.dataset.target);
      edge.classList.toggle('related', selected !== null && touches);
      edge.classList.toggle('faded', selected !== null && !touches);
    }
    for (const button of element('records').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === selected));
  }

  function select(id) {
    if (!positions.has(id)) return;
    selected = id;
    const node = nodes.find(value => value.id === id);
    const blockers = incoming.get(id).length, blocks = outgoing.get(id).length;
    const total = reachable(id, outgoing).size;
    element('selection').textContent = `${node.label} · blocked by ${blockers} · blocks ${blocks}`
      + (total > blocks ? ` (${total} in all downstream)` : '')
      + (cyclic.has(id) ? ' · in a dependency cycle' : blockers === 0 ? ' · nothing is blocking it' : '');
    paint();
    send('selectRecord', { recordId: id });
  }

  function textView() {
    const list = element('records'); list.replaceChildren();
    const labels = new Map(nodes.map(node => [node.id, node.label]));
    for (const node of nodes) {
      const row = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = node.label; button.dataset.id = node.id;
      button.setAttribute('aria-pressed', String(node.id === selected));
      button.addEventListener('click', () => select(node.id)); row.append(button);
      const description = document.createElement('p');
      const blockers = incoming.get(node.id).map(id => labels.get(id)), blocks = outgoing.get(node.id).map(id => labels.get(id));
      description.textContent = `${node.status === null || node.status === undefined ? '' : node.status + ' · '}`
        + `Blocked by: ${blockers.join(', ') || 'nothing'}. Blocks: ${blocks.join(', ') || 'nothing'}.`
        + (cyclic.has(node.id) ? ' In a dependency cycle.' : '');
      row.append(description); list.append(row);
    }
  }

  function summarize() {
    const unblocked = nodes.filter(node => incoming.get(node.id).length === 0).length;
    const parts = [`${nodes.length} work item${nodes.length === 1 ? '' : 's'}`, `${edges.length} link${edges.length === 1 ? '' : 's'}`];
    if (nodes.length !== 0) parts.push(`${unblocked} unblocked`);
    if (cyclic.size !== 0) parts.push(`${cyclic.size} in a dependency cycle`);
    element('summary').textContent = parts.join(' · ');
  }

  function render(projection) {
    nodes = projection.nodes; edges = projection.edges; selected = null; drawing.replaceChildren();
    outgoing.clear(); incoming.clear();
    // Adjacency is by distinct item, not by link record: two records both saying A blocks B are
    // two links to draw and one thing to say about B. Counting them twice would read as two
    // different blockers.
    const after = new Map(nodes.map(node => [node.id, new Set()]));
    const before = new Map(nodes.map(node => [node.id, new Set()]));
    for (const edge of edges) {
      if (!after.has(edge.sourceId) || !before.has(edge.targetId)) throw new Error('Invalid projection');
      after.get(edge.sourceId).add(edge.targetId); before.get(edge.targetId).add(edge.sourceId);
    }
    for (const node of nodes) { outgoing.set(node.id, [...after.get(node.id)]); incoming.set(node.id, [...before.get(node.id)]); }
    components(); layout();
    element('selection').textContent = 'No work item selected'; element('empty').hidden = nodes.length !== 0;
    const parallel = new Map();
    for (const edge of edges) {
      const from = positions.get(edge.sourceId), to = positions.get(edge.targetId);
      const key = JSON.stringify([edge.sourceId, edge.targetId]);
      const rank = parallel.get(key) || 0; parallel.set(key, rank + 1);
      const bend = 34 + 44 * rank / (rank + 1);
      const inCycle = component.get(edge.sourceId) === component.get(edge.targetId);
      const startX = from.x + NODE_WIDTH, startY = from.y + NODE_HEIGHT / 2, endY = to.y + NODE_HEIGHT / 2;
      const path = edge.sourceId === edge.targetId
        ? `M ${from.x + 60} ${from.y} C ${from.x + 10} ${from.y - bend} ${from.x + 150} ${from.y - bend} ${from.x + 120} ${from.y}`
        : to.x <= from.x
          // A link that points back the way the layout runs is drawn under the row, so a cycle
          // reads as a cycle instead of as a straight line crossing whatever is between.
          ? `M ${from.x + NODE_WIDTH / 2} ${from.y + NODE_HEIGHT} C ${from.x} ${from.y + NODE_HEIGHT + bend} ${to.x + NODE_WIDTH} ${endY + bend} ${to.x + NODE_WIDTH / 2} ${to.y + NODE_HEIGHT}`
          : `M ${startX} ${startY} C ${(startX + to.x) / 2} ${startY - bend / 3} ${(startX + to.x) / 2} ${endY - bend / 3} ${to.x} ${endY}`;
      drawing.append(shape('path', {
        d: path, class: inCycle ? 'edge cycle' : 'edge',
        'data-source': edge.sourceId, 'data-target': edge.targetId, 'data-edge-id': edge.id,
      }));
    }
    nodes.forEach((node, index) => {
      const point = positions.get(node.id);
      const group = shape('g', {
        transform: `translate(${point.x} ${point.y})`, class: 'node', tabindex: 0, role: 'button',
        'aria-label': node.label, 'aria-pressed': 'false', 'data-id': node.id,
      });
      const status = node.status === null || node.status === undefined ? null : String(node.status);
      group.append(shape('title', {}, status === null ? node.label : `${node.label} — ${status}`),
        shape('rect', { width: NODE_WIDTH, height: NODE_HEIGHT, rx: 11 }),
        shape('text', { x: 14, y: 26 }, node.label.length > 27 ? node.label.slice(0, 26) + '…' : node.label));
      if (status !== null) {
        group.append(shape('circle', { cx: 19, cy: 44, r: 5, class: 'tone tone-' + (TONES[status.toLowerCase()] ?? 'grey') }),
          shape('text', { x: 30, y: 48, class: 'status' }, status.slice(0, 26)));
      }
      if (cyclic.has(node.id)) group.append(shape('text', { x: NODE_WIDTH - 16, y: 48, class: 'status', 'text-anchor': 'end' }, 'cycle'));
      group.addEventListener('click', () => select(node.id));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.id); }
        else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault(); event.stopPropagation();
          const items = drawing.querySelectorAll('.node');
          items[(index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
        }
      });
      group.addEventListener('focus', () => {
        // Keyboard navigation brings the whole target into view; pointer focus must not move a
        // node between pointer-down and the click it belongs to.
        if (!group.matches(':focus-visible')) return;
        offsetX = canvas.clientWidth / 2 - (point.x + NODE_WIDTH / 2) * scale;
        offsetY = canvas.clientHeight / 2 - (point.y + NODE_HEIGHT / 2) * scale; transform();
      });
      drawing.append(group);
    });
    summarize(); textView(); paint(); fit(); refit();
  }

  element('zoom-in').addEventListener('click', () => zoom(1.25));
  element('zoom-out').addEventListener('click', () => zoom(.8));
  element('reset').addEventListener('click', fit);
  element('focus-toggle').addEventListener('click', () => {
    focusing = !focusing;
    element('focus-toggle').setAttribute('aria-pressed', String(focusing));
    paint();
  });
  element('text-toggle').addEventListener('click', () => {
    const show = element('text-view').hidden; element('text-view').hidden = !show; canvas.hidden = show;
    element('text-toggle').setAttribute('aria-expanded', String(show));
    element('text-toggle').textContent = show ? 'Graph view' : 'Text view';
    if (!show) fit();
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - bounds.left, event.clientY - bounds.top);
  }, { passive: false });
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.node')) return;
    drag = { x: event.clientX, y: event.clientY, offsetX, offsetY }; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => { if (drag) { offsetX = drag.offsetX + event.clientX - drag.x; offsetY = drag.offsetY + event.clientY - drag.y; transform(); } });
  canvas.addEventListener('pointerup', () => { drag = null; }); canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('keydown', event => {
    if (event.key === '+' || event.key === '=') zoom(1.25);
    else if (event.key === '-') zoom(.8);
    else if (event.key === 'ArrowLeft') { offsetX += 40; transform(); }
    else if (event.key === 'ArrowRight') { offsetX -= 40; transform(); }
    else if (event.key === 'ArrowUp') { offsetY += 40; transform(); }
    else if (event.key === 'ArrowDown') { offsetY -= 40; transform(); }
    else return;
    event.preventDefault();
  });
  new ResizeObserver(() => { if (session !== null && !canvas.hidden) fit(); }).observe(canvas);
  window.chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (message.version !== 1) return;
    try {
      if (message.method === 'initialize' && session === null) {
        session = message.session; generation = message.generation;
        document.documentElement.dataset.theme = message.theme;
        document.documentElement.lang = message.locale || 'en';
        render(message.projection); send('ready');
      } else if (message.session === session && message.method === 'replaceProjection' && message.generation > generation) {
        generation = message.generation; render(message.projection);
      } else if (message.session === session && message.method === 'setTheme') document.documentElement.dataset.theme = message.theme;
    } catch {
      element('summary').textContent = 'These dependencies could not be displayed. Open your work items in Nendo.';
      send('reportError', { code: 'render-failed', message: 'The dependency view could not be displayed.' });
    }
  });
})();
