(() => {
  'use strict';
  const element = id => document.getElementById(id);
  const svg = element('graph'), drawing = element('drawing'), canvas = element('canvas');
  let session = null, generation = 0, nodes = [], edges = [], selected = null;
  let width = 800, height = 500, scale = 1, offsetX = 0, offsetY = 0, drag = null;
  const positions = new Map();
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
    // Before the contained window is sized the canvas can measure zero; fitting then puts every node
    // off-screen and the graph looks empty. Skip until it has a real size, and re-fit once it does.
    if (bounds.width < 1 || bounds.height < 1) return;
    scale = Math.min(1.2, Math.max(.08, Math.min(bounds.width / width, bounds.height / height) * .9));
    offsetX = (bounds.width - width * scale) / 2; offsetY = (bounds.height - height * scale) / 2;
    transform();
  }
  // The pane is composed and sized by the host after the page loads, so the first fit can run against
  // a stale size. Re-fit on the next two frames and whenever the window changes, so the graph always
  // opens centred in view even on a large or maximized window that never resizes afterward.
  function refit() { requestAnimationFrame(() => requestAnimationFrame(() => { if (session !== null && !canvas.hidden) fit(); })); }
  window.addEventListener('resize', () => { if (session !== null && !canvas.hidden) fit(); });
  function zoom(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    const next = Math.min(4, Math.max(.08, scale * factor));
    offsetX = x - (x - offsetX) * next / scale; offsetY = y - (y - offsetY) * next / scale;
    scale = next; transform();
  }
  function select(id) {
    if (!positions.has(id)) return;
    selected = id;
    for (const node of drawing.querySelectorAll('.node')) {
      const active = node.dataset.id === id; node.classList.toggle('selected', active); node.setAttribute('aria-pressed', String(active));
    }
    for (const edge of drawing.querySelectorAll('.edge')) edge.classList.toggle('related', edge.dataset.source === id || edge.dataset.target === id);
    for (const button of element('records').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === id));
    const node = nodes.find(value => value.id === id);
    element('selection').textContent = `${node.label} selected · ${edges.filter(e => e.targetId === id).length} incoming · ${edges.filter(e => e.sourceId === id).length} outgoing`;
    send('selectRecord', { recordId: id });
  }
  function textView() {
    const list = element('records'); list.replaceChildren();
    const labels = new Map(nodes.map(n => [n.id, n.label]));
    for (const node of nodes) {
      const row = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = node.label; button.dataset.id = node.id; button.setAttribute('aria-pressed', String(node.id === selected));
      button.addEventListener('click', () => select(node.id)); row.append(button);
      const description = document.createElement('p');
      const incoming = edges.filter(e => e.targetId === node.id).map(e => labels.get(e.sourceId));
      const outgoing = edges.filter(e => e.sourceId === node.id).map(e => labels.get(e.targetId));
      description.textContent = `${node.status === null || node.status === undefined ? '' : node.status + ' · '}Incoming: ${incoming.join(', ') || 'none'}. Outgoing: ${outgoing.join(', ') || 'none'}.`;
      row.append(description); list.append(row);
    }
  }
  function render(projection) {
    nodes = projection.nodes; edges = projection.edges; selected = null; positions.clear(); drawing.replaceChildren();
    element('summary').textContent = `${nodes.length} record${nodes.length === 1 ? '' : 's'} · ${edges.length} connection${edges.length === 1 ? '' : 's'}`;
    element('selection').textContent = 'No record selected'; element('empty').hidden = nodes.length !== 0;
    // Deterministic placement handles cycles, self-links, parallel edges and isolated records alike.
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.5)));
    nodes.forEach((node, index) => positions.set(node.id, { x: 30 + index % columns * 230, y: 80 + Math.floor(index / columns) * 160 }));
    width = Math.max(260, columns * 230 + 30); height = Math.max(230, Math.ceil(nodes.length / columns) * 160 + 80);
    const parallel = new Map();
    edges.forEach(edge => {
      const from = positions.get(edge.sourceId), to = positions.get(edge.targetId);
      if (!from || !to) throw new Error('Invalid projection');
      const key = JSON.stringify([edge.sourceId, edge.targetId]);
      const rank = parallel.get(key) || 0; parallel.set(key, rank + 1);
      const bend = 30 + 40 * rank / (rank + 1);
      const path = edge.sourceId === edge.targetId
        ? `M ${from.x + 100} ${from.y} C ${from.x + 45} ${from.y - bend} ${from.x + 165} ${from.y - bend} ${from.x + 145} ${from.y}`
        : to.y === from.y && to.x < from.x
          ? `M ${from.x + 80} ${from.y} C ${from.x + 80} ${from.y - bend} ${to.x + 110} ${to.y - bend} ${to.x + 110} ${to.y}`
          : `M ${from.x + 190} ${from.y + 33} C ${(from.x + 190 + to.x) / 2} ${from.y + 33 - bend} ${(from.x + 190 + to.x) / 2} ${to.y + 33 - bend} ${to.x} ${to.y + 33}`;
      const line = shape('path', { d: path, class: 'edge', 'data-source': edge.sourceId, 'data-target': edge.targetId, 'data-edge-id': edge.id });
      drawing.append(line);
    });
    nodes.forEach((node, index) => {
      const point = positions.get(node.id);
      const group = shape('g', { transform: `translate(${point.x} ${point.y})`, class: 'node', tabindex: 0, role: 'button', 'aria-label': node.label, 'aria-pressed': 'false', 'data-id': node.id });
      group.append(shape('title', {}, node.label), shape('rect', { width: 190, height: 66, rx: 11 }),
        shape('text', { x: 12, y: 27 }, node.label.length > 25 ? node.label.slice(0, 24) + '…' : node.label));
      if (node.status !== null && node.status !== undefined) group.append(shape('text', { x: 12, y: 48, class: 'status' }, String(node.status).slice(0, 27)));
      group.addEventListener('click', () => select(node.id));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.id); }
        else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault(); event.stopPropagation();
          const items = drawing.querySelectorAll('.node'); items[(index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
        }
      });
      group.addEventListener('focus', () => {
        // Keyboard navigation brings the complete target into the viewport.
        // Pointer focus must not move a node between pointer-down and click.
        if (!group.matches(':focus-visible')) return;
        offsetX = canvas.clientWidth / 2 - (point.x + 95) * scale;
        offsetY = canvas.clientHeight / 2 - (point.y + 33) * scale; transform();
      });
      drawing.append(group);
    });
    textView(); fit(); refit();
  }
  element('zoom-in').addEventListener('click', () => zoom(1.25));
  element('zoom-out').addEventListener('click', () => zoom(.8));
  element('reset').addEventListener('click', fit);
  element('text-toggle').addEventListener('click', () => {
    const show = element('text-view').hidden; element('text-view').hidden = !show; canvas.hidden = show;
    element('text-toggle').setAttribute('aria-expanded', String(show)); element('text-toggle').textContent = show ? 'Graph view' : 'Text view';
    if (!show) fit();
  });
  canvas.addEventListener('wheel', event => { event.preventDefault(); const r = canvas.getBoundingClientRect(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - r.left, event.clientY - r.top); }, { passive: false });
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
        session = message.session; generation = message.generation; document.documentElement.dataset.theme = message.theme;
        document.documentElement.lang = message.locale || 'en'; render(message.projection); send('ready');
      } else if (message.session === session && message.method === 'replaceProjection' && message.generation > generation) {
        generation = message.generation; render(message.projection);
      } else if (message.session === session && message.method === 'setTheme') document.documentElement.dataset.theme = message.theme;
    } catch { element('summary').textContent = 'This graph could not be displayed. Open your records in Nendo.'; send('reportError', { code: 'render-failed', message: 'The graph could not be displayed.' }); }
  });
})();
