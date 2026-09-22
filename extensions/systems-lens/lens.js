(() => {
  'use strict';
  const element = id => document.getElementById(id);
  const drawing = element('drawing'), canvas = element('canvas');
  let session = null, generation = 0, nodes = [], edges = [], selected = null, focusing = false, removed = null;
  let width = 800, height = 500, scale = 1, offsetX = 0, offsetY = 0, drag = null;
  const positions = new Map();     // node id -> {x, y}
  const component = new Map();     // node id -> strongly connected component index
  const looping = new Set();       // node ids that sit in a real circuit
  const outgoing = new Map();      // node id -> [node id]
  const incoming = new Map();      // node id -> [node id]
  let seeds = [];                  // components nothing declares a feed into
  let baseline = new Set();        // what the sources reach with everything present
  const NODE_WIDTH = 218, NODE_HEIGHT = 66, COLUMN = 270, ROW = 98;
  // The station's own component states, in the file's own tones. Any other value is
  // drawn neutral rather than guessed at, so this package stays usable against
  // another file's scalar.
  const TONES = { online: 'green', standby: 'blue', offline: 'red', removed: 'grey' };
  const SEPARATOR = ' · ';

  function send(method, values = {}) {
    if (session !== null) window.chrome.webview.postMessage({ version: 1, session, generation, method, ...values });
  }
  function shape(name, attributes, text) {
    const item = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = text;
    return item;
  }
  // A label may carry the system it belongs to, as SYSTEM followed by the name. That
  // is a convention between the file and this package: the host discloses a label and
  // one status, and a label without the separator is simply a name.
  function band(label) {
    const at = label.indexOf(SEPARATOR);
    return at === -1 ? { band: null, name: label } : { band: label.slice(0, at), name: label.slice(at + SEPARATOR.length) };
  }
  function transform() { drawing.setAttribute('transform', `translate(${offsetX} ${offsetY}) scale(${scale})`); }
  function fit() {
    const bounds = canvas.getBoundingClientRect();
    // The host composes and sizes this pane after the page loads, so an early fit can
    // measure zero and put every component off-screen.
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
   * Tarjan's strongly connected components. A coolant circuit is a cycle and a water
   * loop is a cycle, so naming them exactly matters more here than it does on a graph
   * of work: a component merely standing behind a loop is not in one. Iterative,
   * because this runs inside a contained renderer with no stack to spare.
   */
  function components() {
    component.clear(); looping.clear();
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
          if (members.length > 1 || outgoing.get(frame.id).includes(frame.id)) for (const id of members) looping.add(id);
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
   * Longest-path layering over the condensed graph, so a component sits to the right
   * of everything that supplies it. Edges inside one circuit are left out of the
   * ordering: they are the loop, and keeping them would mean no ordering exists.
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
    // Within a column, components of the same system stay together, so a schematic
    // reads by system as well as by direction of supply.
    const ordered = [...nodes].sort((left, right) => {
      const a = band(left.label), b = band(right.label);
      return (a.band ?? '').localeCompare(b.band ?? '') || a.name.localeCompare(b.name);
    });
    for (const node of ordered) {
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

  function walk(from, map) {
    const seen = new Set(), queue = [from];
    while (queue.length !== 0) {
      for (const next of map.get(queue.pop()) ?? []) if (!seen.has(next) && next !== from) { seen.add(next); queue.push(next); }
    }
    return seen;
  }

  /**
   * What the declared sources still reach when one component is taken out. The seeds
   * are the components nothing declares a feed into — a tank, an array, a sensor —
   * and they are read once from the whole graph. Recomputing them without the removed
   * component would turn a component fed only by it into a source of its own, and the
   * one thing this view exists to say would be exactly the thing it got wrong.
   */
  function reach(skip) {
    const seen = new Set(), queue = [];
    for (const id of seeds) if (id !== skip) { seen.add(id); queue.push(id); }
    while (queue.length !== 0) {
      const id = queue.pop();
      for (const next of outgoing.get(id) ?? []) {
        if (next === skip || seen.has(next)) continue;
        seen.add(next); queue.push(next);
      }
    }
    return seen;
  }

  /**
   * Exposed is not "downstream". A radiator on two pumps keeps a path when one is
   * taken out, and a view that painted everything downstream would say it did not.
   */
  function verdicts() {
    if (removed === null) return new Map();
    const without = reach(removed), below = walk(removed, outgoing);
    const answer = new Map([[removed, 'removed']]);
    for (const node of nodes) {
      if (node.id === removed) continue;
      if (baseline.has(node.id) && !without.has(node.id)) answer.set(node.id, 'exposed');
      else if (below.has(node.id)) answer.set(node.id, 'reduced');
    }
    return answer;
  }

  function paint() {
    const upstream = selected === null ? new Set() : walk(selected, incoming);
    const downstream = selected === null ? new Set() : walk(selected, outgoing);
    const connected = new Set([...upstream, ...downstream]);
    if (selected !== null) connected.add(selected);
    const verdict = verdicts();
    drawing.classList.toggle('focused', focusing && selected !== null);
    element('caveat').hidden = removed === null;
    for (const node of drawing.querySelectorAll('.node')) {
      const id = node.dataset.id;
      node.classList.toggle('selected', id === selected);
      node.classList.toggle('upstream', removed === null && upstream.has(id));
      node.classList.toggle('downstream', removed === null && downstream.has(id));
      node.classList.toggle('faded', selected !== null && !connected.has(id));
      node.classList.toggle('exposed', verdict.get(id) === 'exposed');
      node.classList.toggle('reduced', verdict.get(id) === 'reduced');
      node.classList.toggle('removed', verdict.get(id) === 'removed');
      node.setAttribute('aria-pressed', String(id === selected));
      const mark = node.querySelector('.verdict');
      const words = { exposed: 'no path', reduced: 'still fed', removed: 'taken out' };
      mark.textContent = words[verdict.get(id)] ?? (looping.has(id) ? 'loop' : '');
    }
    for (const edge of drawing.querySelectorAll('.edge')) {
      const touches = connected.has(edge.dataset.source) && connected.has(edge.dataset.target);
      edge.classList.toggle('related', removed === null && selected !== null && touches);
      edge.classList.toggle('faded', selected !== null && !touches);
      edge.classList.toggle('cut', removed !== null && (edge.dataset.source === removed || edge.dataset.target === removed));
    }
    for (const button of element('records').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === selected));
    textView(verdict);
    summarize(verdict);
  }

  function labelOf(id) { return nodes.find(node => node.id === id)?.label ?? id; }

  function select(id) {
    if (!positions.has(id)) return;
    selected = id;
    element('takeout-toggle').disabled = false;
    const fed = incoming.get(id).length, feeds = outgoing.get(id).length;
    const total = walk(id, outgoing).size;
    element('selection').textContent = `${labelOf(id)} · fed by ${fed} · feeds ${feeds}`
      + (total > feeds ? ` (${total} downstream in all)` : '')
      + (looping.has(id) ? ' · in a circuit' : fed === 0 ? ' · a declared source' : '')
      + (baseline.has(id) ? '' : ' · no declared source reaches it');
    paint();
    send('selectRecord', { recordId: id });
  }

  function textView(verdict) {
    const list = element('records'); list.replaceChildren();
    for (const node of nodes) {
      const row = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = node.label; button.dataset.id = node.id;
      button.setAttribute('aria-pressed', String(node.id === selected));
      button.addEventListener('click', () => select(node.id)); row.append(button);
      const description = document.createElement('p');
      const fed = incoming.get(node.id).map(labelOf), feeds = outgoing.get(node.id).map(labelOf);
      description.textContent = `${node.status === null || node.status === undefined ? '' : node.status + ' · '}`
        + `Fed by: ${fed.join(', ') || 'nothing'}. Feeds: ${feeds.join(', ') || 'nothing'}.`
        + (looping.has(node.id) ? ' In a circuit.' : '')
        + (baseline.has(node.id) ? '' : ' No declared source reaches it.');
      row.append(description);
      const answer = verdict.get(node.id);
      if (answer !== undefined) {
        const mark = document.createElement('p');
        mark.className = answer === 'exposed' ? 'verdict-exposed' : answer === 'reduced' ? 'verdict-reduced' : '';
        mark.textContent = answer === 'removed'
          ? `Taken out of the schematic for this question.`
          : answer === 'exposed'
            ? `Without ${labelOf(removed)} it loses every declared feed path.`
            : `Without ${labelOf(removed)} it keeps a declared feed path.`;
        row.append(mark);
      }
      list.append(row);
    }
  }

  function summarize(verdict) {
    if (removed !== null) {
      let exposed = 0, reduced = 0;
      for (const answer of verdict.values()) { if (answer === 'exposed') exposed += 1; if (answer === 'reduced') reduced += 1; }
      element('summary').textContent = `Without ${labelOf(removed)}: ${exposed} lose every declared path`
        + `, ${reduced} keep one`;
      return;
    }
    const parts = [`${nodes.length} component${nodes.length === 1 ? '' : 's'}`, `${edges.length} feed${edges.length === 1 ? '' : 's'}`];
    if (nodes.length !== 0) parts.push(`${seeds.length} declared source${seeds.length === 1 ? '' : 's'}`);
    if (looping.size !== 0) parts.push(`${looping.size} in a circuit`);
    const stranded = nodes.filter(node => !baseline.has(node.id)).length;
    if (stranded !== 0) parts.push(`${stranded} no source reaches`);
    element('summary').textContent = parts.join(' · ');
  }

  function render(projection) {
    nodes = projection.nodes; edges = projection.edges; selected = null; removed = null;
    drawing.replaceChildren();
    element('takeout-toggle').disabled = true;
    element('takeout-toggle').setAttribute('aria-pressed', 'false');
    outgoing.clear(); incoming.clear();
    // Adjacency is by distinct component, not by feed record: two records both saying
    // A supplies B are two feeds to draw and one thing to say about B.
    const after = new Map(nodes.map(node => [node.id, new Set()]));
    const before = new Map(nodes.map(node => [node.id, new Set()]));
    for (const edge of edges) {
      if (!after.has(edge.sourceId) || !before.has(edge.targetId)) throw new Error('Invalid projection');
      after.get(edge.sourceId).add(edge.targetId); before.get(edge.targetId).add(edge.sourceId);
    }
    for (const node of nodes) { outgoing.set(node.id, [...after.get(node.id)]); incoming.set(node.id, [...before.get(node.id)]); }
    seeds = nodes.filter(node => incoming.get(node.id).length === 0).map(node => node.id);
    baseline = reach(null);
    components(); layout();
    element('selection').textContent = 'No component selected'; element('empty').hidden = nodes.length !== 0;
    const parallel = new Map();
    for (const edge of edges) {
      const from = positions.get(edge.sourceId), to = positions.get(edge.targetId);
      const key = JSON.stringify([edge.sourceId, edge.targetId]);
      const rank = parallel.get(key) || 0; parallel.set(key, rank + 1);
      const bend = 34 + 44 * rank / (rank + 1);
      const inLoop = component.get(edge.sourceId) === component.get(edge.targetId);
      const startX = from.x + NODE_WIDTH, startY = from.y + NODE_HEIGHT / 2, endY = to.y + NODE_HEIGHT / 2;
      const path = edge.sourceId === edge.targetId
        ? `M ${from.x + 60} ${from.y} C ${from.x + 10} ${from.y - bend} ${from.x + 150} ${from.y - bend} ${from.x + 120} ${from.y}`
        : to.x <= from.x
          // A return leg is drawn under the row, so a circuit reads as a circuit
          // instead of as a straight line crossing whatever is between.
          ? `M ${from.x + NODE_WIDTH / 2} ${from.y + NODE_HEIGHT} C ${from.x} ${from.y + NODE_HEIGHT + bend} ${to.x + NODE_WIDTH} ${endY + bend} ${to.x + NODE_WIDTH / 2} ${to.y + NODE_HEIGHT}`
          : `M ${startX} ${startY} C ${(startX + to.x) / 2} ${startY - bend / 3} ${(startX + to.x) / 2} ${endY - bend / 3} ${to.x} ${endY}`;
      drawing.append(shape('path', {
        d: path, class: inLoop ? 'edge loop' : 'edge',
        'data-source': edge.sourceId, 'data-target': edge.targetId, 'data-edge-id': edge.id,
      }));
    }
    nodes.forEach((node, index) => {
      const point = positions.get(node.id);
      const parts = band(node.label);
      const status = node.status === null || node.status === undefined ? null : String(node.status);
      const group = shape('g', {
        transform: `translate(${point.x} ${point.y})`, class: 'node', tabindex: 0, role: 'button',
        'aria-label': node.label, 'aria-pressed': 'false', 'data-id': node.id,
        'data-band': parts.band ?? '',
      });
      if (status !== null && status.toLowerCase() === 'offline') group.classList.add('offline');
      group.append(shape('title', {}, status === null ? node.label : `${node.label} — ${status}`),
        shape('rect', { width: NODE_WIDTH, height: NODE_HEIGHT, rx: 11 }),
        shape('text', { x: 14, y: 27 }, parts.name.length > 27 ? parts.name.slice(0, 26) + '…' : parts.name));
      if (parts.band !== null) {
        group.append(shape('text', { x: NODE_WIDTH - 14, y: 27, class: 'band', 'text-anchor': 'end' }, parts.band.slice(0, 10)));
      }
      if (status !== null) {
        group.append(shape('circle', { cx: 19, cy: 46, r: 5, class: 'tone tone-' + (TONES[status.toLowerCase()] ?? 'grey') }),
          shape('text', { x: 30, y: 50, class: 'status' }, status.slice(0, 22)));
      }
      group.append(shape('text', { x: NODE_WIDTH - 14, y: 50, class: 'verdict', 'text-anchor': 'end' },
        looping.has(node.id) ? 'loop' : ''));
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
        if (!group.matches(':focus-visible')) return;
        offsetX = canvas.clientWidth / 2 - (point.x + NODE_WIDTH / 2) * scale;
        offsetY = canvas.clientHeight / 2 - (point.y + NODE_HEIGHT / 2) * scale; transform();
      });
      drawing.append(group);
    });
    paint(); fit(); refit();
  }

  function setTakeOut(id) {
    removed = id;
    const button = element('takeout-toggle');
    button.setAttribute('aria-pressed', String(id !== null));
    button.textContent = id === null ? 'Take out' : 'Put back';
    paint();
  }

  element('zoom-in').addEventListener('click', () => zoom(1.25));
  element('zoom-out').addEventListener('click', () => zoom(.8));
  element('reset').addEventListener('click', fit);
  element('focus-toggle').addEventListener('click', () => {
    focusing = !focusing;
    element('focus-toggle').setAttribute('aria-pressed', String(focusing));
    paint();
  });
  element('takeout-toggle').addEventListener('click', () => setTakeOut(removed === null ? selected : null));
  element('text-toggle').addEventListener('click', () => {
    const show = element('text-view').hidden; element('text-view').hidden = !show; canvas.hidden = show;
    element('text-toggle').setAttribute('aria-expanded', String(show));
    element('text-toggle').textContent = show ? 'Schematic' : 'Text view';
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
  // A what-if is session state and nothing else. Escape puts it back, and so does any
  // new projection: the graph may have changed under the question.
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && removed !== null) setTakeOut(null); });
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
      element('summary').textContent = 'This schematic could not be displayed. Open your components in Nendo.';
      send('reportError', { code: 'render-failed', message: 'The schematic could not be displayed.' });
    }
  });
})();
