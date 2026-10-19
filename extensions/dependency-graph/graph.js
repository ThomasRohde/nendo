(() => {
  'use strict';
  // Records as nodes and link records as directed edges. Everything arrives through
  // window.nendo (ADR-0013): the graph from nendo.view.loadGraph, the names of a status's
  // choices from nendo.schema.describe, and the theme. Selecting a record asks Nendo to open it.
  const element = id => document.getElementById(id);
  const svg = element('graph'), drawing = element('drawing'), canvas = element('canvas');
  const nendo = window.nendo;
  let loaded = false, nodes = [], edges = [], hidden = 0, selected = null;
  // Whether the person has zoomed or panned since the graph was last fitted. A re-read keeps
  // where they are then, rather than fitting the whole graph again.
  let moved = false;
  // True while a redraw puts focus back where it was, so that focus does not move the drawing.
  let restoring = false;
  let width = 800, height = 500, scale = 1, offsetX = 0, offsetY = 0, drag = null;
  // Reads are numbered so an answer that arrives after a newer read has started is dropped.
  let latest = 0, pending = null;
  // True where Nendo draws this view's controls in its own toolbar, and whether the
  // explanation is shown over the graph.
  let nativeChrome = false, aboutShown = false;
  const positions = new Map();
  // The view kit (tools/view-kit, copied into kit/): the records are one tab stop, and the arrow
  // keys go to the nearest record in that direction on the drawing, not the next in the file's
  // order. Loaded as a module from this classic script; until it arrives, every record
  // is a tab stop and Enter opens it.
  let keys = null;
  import('./kit/nendo-view-kit.js').then(kit => {
    keys = kit.roving(drawing, { items: '.node', orientation: 'spatial', onActivate: node => select(node.dataset.id) });
  }).catch(() => undefined);
  function shape(name, attributes, text) {
    const item = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function describe(error) { return error instanceof Error && error.message ? error.message : String(error); }
  function transform() { drawing.setAttribute('transform', `translate(${offsetX} ${offsetY}) scale(${scale})`); }
  function fit() {
    const bounds = canvas.getBoundingClientRect();
    // Before the frame is sized the canvas can measure zero; fitting then puts every node
    // off-screen and the graph looks empty. Skip until it has a real size, and re-fit once it does.
    if (bounds.width < 1 || bounds.height < 1) return;
    scale = Math.min(1.2, Math.max(.08, Math.min(bounds.width / width, bounds.height / height) * .9));
    offsetX = (bounds.width - width * scale) / 2; offsetY = (bounds.height - height * scale) / 2;
    transform();
  }
  // The frame is laid out and sized by the Workbench after the page loads, so the first fit can
  // run against a stale size. Re-fit on the next two frames and whenever the window changes, so
  // the graph always opens centred in view even in a large frame that never resizes afterward.
  function refit() { requestAnimationFrame(() => requestAnimationFrame(() => { if (loaded && !canvas.hidden && !moved) fit(); })); }
  window.addEventListener('resize', () => { if (loaded && !canvas.hidden && !moved) fit(); });
  // Fit, Ctrl 0 and coming back from the text view fit the whole graph, and a re-read keeps that.
  function fitAgain() { moved = false; fit(); }
  function zoom(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    moved = true;
    const next = Math.min(4, Math.max(.08, scale * factor));
    offsetX = x - (x - offsetX) * next / scale; offsetY = y - (y - offsetY) * next / scale;
    scale = next; transform();
  }
  function highlight(id) {
    selected = id;
    for (const node of drawing.querySelectorAll('.node')) {
      const active = node.dataset.id === id; node.classList.toggle('selected', active); node.setAttribute('aria-pressed', String(active));
    }
    for (const edge of drawing.querySelectorAll('.edge')) edge.classList.toggle('related', edge.dataset.source === id || edge.dataset.target === id);
    for (const button of element('records').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === id));
    const node = nodes.find(value => value.id === id);
    element('selection').textContent = `${node.label} selected · ${edges.filter(e => e.targetId === id).length} incoming · ${edges.filter(e => e.sourceId === id).length} outgoing`;
  }
  function select(id) {
    if (!positions.has(id)) return;
    highlight(id);
    const node = nodes.find(value => value.id === id);
    nendo.ui.openRecord(node.entityId, id).catch(error => {
      if (selected === id) element('selection').textContent = `${node.label} selected · Nendo could not open it: ${describe(error)}`;
    });
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
  // The record that has the keyboard before a redraw replaces it, in the drawing or the text view.
  function focusedItem() {
    const active = document.activeElement;
    for (const container of [drawing, element('records')]) {
      if (active instanceof Element && active !== container && container.contains(active) && active.dataset.id !== undefined)
        return { container, id: active.dataset.id, index: [...container.querySelectorAll('[data-id]')].indexOf(active) };
    }
    return null;
  }
  // Gives the keyboard back to that record after the redraw, or to the one now where it was, so
  // focus does not fall to the page. Giving it back moves nothing.
  function restoreFocus(was) {
    if (was === null) return;
    const items = [...was.container.querySelectorAll('[data-id]')];
    const target = items.find(item => item.dataset.id === was.id) ?? items[Math.min(was.index, items.length - 1)];
    if (target === undefined) return;
    restoring = true;
    try { target.focus({ preventScroll: true }); } finally { restoring = false; }
  }
  function render(projection) {
    // A re-read keeps the selection when its record is still there, without opening it again.
    const keep = selected, had = focusedItem(), before = new Map(positions);
    nodes = projection.nodes; edges = projection.edges; hidden = projection.hidden; selected = null; positions.clear(); drawing.replaceChildren();
    // A link to a record this view does not show is left out of the drawing, and said.
    setSummary(`${nodes.length} record${nodes.length === 1 ? '' : 's'} · ${edges.length} connection${edges.length === 1 ? '' : 's'}`
      + (hidden > 0 ? ` · ${hidden} connection${hidden === 1 ? '' : 's'} outside this view` : ''));
    element('selection').textContent = 'No record selected'; element('empty').hidden = nodes.length !== 0;
    // Deterministic placement handles cycles, self-links, parallel edges and isolated records alike.
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.5)));
    nodes.forEach((node, index) => positions.set(node.id, { x: 30 + index % columns * 230, y: 80 + Math.floor(index / columns) * 160 }));
    // The drawing is as wide as the columns it uses and as tall as its rows, with the same margin
    // on either side, so fitting it centres the records: one record sits in the middle.
    const used = Math.min(columns, Math.max(1, nodes.length)), rows = Math.max(1, Math.ceil(nodes.length / columns));
    width = used * 230 + 20; height = rows * 160 + 66;
    const parallel = new Map();
    edges.forEach(edge => {
      const from = positions.get(edge.sourceId), to = positions.get(edge.targetId);
      if (!from || !to) throw new Error('Invalid projection');
      const key = JSON.stringify([edge.sourceId, edge.targetId]);
      const rank = parallel.get(key) || 0; parallel.set(key, rank + 1);
      const bend = 30 + 40 * rank / (rank + 1);
      // Every link ends outside its target, where its arrowhead shows: on the left edge
      // of a record further right, over the top of one to the left on the same row, on the top
      // edge of one on a lower row and on the bottom edge of one on a higher row. Ending on the
      // left edge of a record below or behind put the arrowhead inside it, under its box. A link
      // within one column runs beside it, from side to side: down the right, up the left, bowed
      // further for each parallel link, so a cycle or a pair reads as two lines and a link past a
      // row does not run through the record between.
      const side = 28 + 12 * rank;
      const path = edge.sourceId === edge.targetId
        ? `M ${from.x + 100} ${from.y} C ${from.x + 45} ${from.y - bend} ${from.x + 165} ${from.y - bend} ${from.x + 145} ${from.y}`
        : to.y === from.y && to.x < from.x
          ? `M ${from.x + 80} ${from.y} C ${from.x + 80} ${from.y - bend} ${to.x + 110} ${to.y - bend} ${to.x + 110} ${to.y}`
          : to.x === from.x
            ? to.y > from.y
              ? `M ${from.x + 190} ${from.y + 33} C ${from.x + 190 + side} ${from.y + 33} ${to.x + 190 + side} ${to.y + 33} ${to.x + 190} ${to.y + 33}`
              : `M ${from.x} ${from.y + 33} C ${from.x - side} ${from.y + 33} ${to.x - side} ${to.y + 33} ${to.x} ${to.y + 33}`
          : to.x > from.x
            ? `M ${from.x + 190} ${from.y + 33} C ${(from.x + 190 + to.x) / 2} ${from.y + 33 - bend} ${(from.x + 190 + to.x) / 2} ${to.y + 33 - bend} ${to.x} ${to.y + 33}`
            : to.y > from.y
              ? `M ${from.x + 95} ${from.y + 66} C ${from.x + 95} ${from.y + 66 + bend} ${to.x + 95} ${to.y - bend} ${to.x + 95} ${to.y}`
              : `M ${from.x + 95} ${from.y} C ${from.x + 95} ${from.y - bend} ${to.x + 95} ${to.y + 66 + bend} ${to.x + 95} ${to.y + 66}`;
      const line = shape('path', { d: path, class: 'edge', 'data-source': edge.sourceId, 'data-target': edge.targetId, 'data-edge-id': edge.id });
      drawing.append(line);
    });
    nodes.forEach(node => {
      const point = positions.get(node.id);
      const group = shape('g', { transform: `translate(${point.x} ${point.y})`, class: 'node', tabindex: 0, role: 'button', 'aria-label': node.label, 'aria-pressed': 'false', 'data-id': node.id });
      group.append(shape('title', {}, node.label), shape('rect', { width: 190, height: 66, rx: 11 }),
        shape('text', { x: 12, y: 27 }, node.label.length > 25 ? node.label.slice(0, 24) + '…' : node.label));
      if (node.status !== null && node.status !== undefined) group.append(shape('text', { x: 12, y: 48, class: 'status' }, String(node.status).slice(0, 27)));
      group.addEventListener('click', () => select(node.id));
      // The kit's keys move between records and Enter opens one; this is for the moment before
      // the kit has loaded.
      group.addEventListener('keydown', event => {
        if (keys === null && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(node.id); }
      });
      group.addEventListener('focus', () => {
        // Keyboard navigation brings the complete target into the viewport.
        // Pointer focus must not move a node between pointer-down and click, and focus given
        // back after a re-read moves nothing.
        if (restoring || !group.matches(':focus-visible')) return;
        moved = true;
        offsetX = canvas.clientWidth / 2 - (point.x + 95) * scale;
        offsetY = canvas.clientHeight / 2 - (point.y + 33) * scale; transform();
      });
      drawing.append(group);
    });
    textView();
    // The person's zoom and pan stay while any record they were looking at is still drawn; the
    // first drawing, and a graph that is all new, are fitted. A record added or taken
    // away moves the others on the grid, so the selected record, or else the focused one, stays
    // at the point on screen where it was.
    if (moved && nodes.some(node => before.has(node.id))) {
      const anchor = [keep, had?.id].find(id => id != null && before.has(id) && positions.has(id));
      if (anchor !== undefined) {
        offsetX += (before.get(anchor).x - positions.get(anchor).x) * scale;
        offsetY += (before.get(anchor).y - positions.get(anchor).y) * scale;
      }
      transform();
    } else { moved = false; fit(); refit(); }
    if (keep !== null && positions.has(keep)) highlight(keep);
    keys?.refresh();
    restoreFocus(had);
  }
  // A field's value as a person reads it: a reference by its target's label, a choice by its
  // name, a number by its exact digits. Null when the record has none.
  function display(schema, record, fieldId) {
    const label = record.labels?.[fieldId];
    if (typeof label === 'string') return label;
    const value = record.values?.[fieldId];
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const field = schema.entities.find(entity => entity.entityId === record.entityId)?.fields.find(candidate => candidate.fieldId === fieldId);
      return field?.choices.find(choice => choice.id === value)?.displayName ?? value;
    }
    return record.exact?.[fieldId] ?? (typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  function project(graph, schema) {
    const statusFieldId = nendo.context.bindings.statusFieldId;
    return {
      nodes: graph.nodes.map(node => ({ id: node.id, entityId: node.record.entityId, label: node.label,
        status: statusFieldId === null ? null : display(schema, node.record, statusFieldId) })),
      edges: graph.edges.map(edge => ({ id: edge.id, sourceId: edge.source, targetId: edge.target })),
      hidden: Number.isInteger(graph.hiddenEdges) ? graph.hiddenEdges : 0,
    };
  }
  async function read() {
    const number = ++latest;
    let graph, schema;
    try {
      [graph, schema] = await Promise.all([nendo.view.loadGraph(), nendo.schema.describe()]);
    } catch (error) {
      if (number === latest) setSummary(`Your records could not be read. ${describe(error)}`, true);
      return;
    }
    if (number !== latest) return;
    loaded = true;
    try { render(project(graph, schema)); } catch { setSummary('This graph could not be displayed. Open your records in Nendo.', true); }
  }
  // Nendo says the file changed at most four times a second. A burst of changes is one read,
  // a quarter of a second after the first of them.
  function schedule() {
    if (pending !== null) return;
    pending = setTimeout(() => { pending = null; read(); }, 250);
  }
  function applyTheme(theme) {
    if (theme?.mode === 'light' || theme?.mode === 'dark') document.documentElement.dataset.theme = theme.mode;
  }
  function setTextShown(show) {
    element('text-view').hidden = !show; canvas.hidden = show;
    element('text-toggle').setAttribute('aria-expanded', String(show)); element('text-toggle').textContent = show ? 'Graph view' : 'Text view';
    if (!show) fitAgain();
    declareToolbar();
  }
  element('zoom-in').addEventListener('click', () => zoom(1.25));
  element('zoom-out').addEventListener('click', () => zoom(.8));
  element('reset').addEventListener('click', fitAgain);
  element('text-toggle').addEventListener('click', () => setTextShown(element('text-view').hidden));
  canvas.addEventListener('wheel', event => { event.preventDefault(); const r = canvas.getBoundingClientRect(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - r.left, event.clientY - r.top); }, { passive: false });
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.node')) return;
    drag = { x: event.clientX, y: event.clientY, offsetX, offsetY }; canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => { if (drag) { moved = true; offsetX = drag.offsetX + event.clientX - drag.x; offsetY = drag.offsetY + event.clientY - drag.y; transform(); } });
  canvas.addEventListener('pointerup', () => { drag = null; }); canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('keydown', event => {
    // On a record the arrow keys are the kit's, between records; on the canvas itself they pan.
    if (event.key.startsWith('Arrow') && event.target !== canvas) return;
    if (event.key === '+' || event.key === '=') zoom(1.25);
    else if (event.key === '-') zoom(.8);
    else if (event.key === 'ArrowLeft') { moved = true; offsetX += 40; transform(); }
    else if (event.key === 'ArrowRight') { moved = true; offsetX -= 40; transform(); }
    else if (event.key === 'ArrowUp') { moved = true; offsetY += 40; transform(); }
    else if (event.key === 'ArrowDown') { moved = true; offsetY -= 40; transform(); }
    else return;
    event.preventDefault();
  });
  new ResizeObserver(() => { if (loaded && !canvas.hidden && !moved) fit(); }).observe(canvas);

  // --- Nendo's own chrome ---------------------------------------------------------
  //
  // Where the host offers it, this view does not draw its controls: it declares them, and
  // Nendo draws them in the toolbar every screen has, lists them in Ctrl K with their keys and
  // sends a press back as a command. A right-click on a record opens Nendo's menu. The page's
  // title gives way to Nendo's own breadcrumb.

  // The view's own lines: where Nendo draws the controls, the summary is declared as
  // text in Nendo's row and the explanation waits behind About, so neither spends a line of the
  // frame. A summary that reports a problem stays in the frame, whole.
  function setSummary(text, problem = false) {
    const line = element('summary');
    line.textContent = text;
    line.classList.toggle('problem', problem);
    declareToolbar();
  }
  function summaryItem() {
    const line = element('summary'), text = line.textContent.trim();
    if (line.classList.contains('problem') || text === '') return null;
    return { kind: 'text', text: text.length > 80 ? text.slice(0, 79) + '\u2026' : text };
  }
  function setAboutShown(on) {
    aboutShown = on;
    document.documentElement.classList.toggle('about-shown', on);
    declareToolbar();
  }
  function aboutItem() {
    return { kind: 'toggle', id: 'about', label: 'About this view', icon: 'info', iconOnly: true, pressed: aboutShown };
  }

  function declareToolbar() {
    if (!nativeChrome) return;
    const textShown = !element('text-view').hidden;
    // The summary takes the row's free space; without one, a spacer does.
    const items = [summaryItem() ?? { kind: 'spacer' }];
    if (!textShown) {
      items.push({ kind: 'group', label: 'Zoom', items: [
        { kind: 'button', id: 'zoom-out', label: 'Zoom out', icon: 'minus', iconOnly: true, keys: 'Ctrl+-' },
        { kind: 'button', id: 'fit', label: 'Fit', keys: 'Ctrl+0' },
        { kind: 'button', id: 'zoom-in', label: 'Zoom in', icon: 'plus', iconOnly: true, keys: 'Ctrl+Plus' },
      ] }, { kind: 'separator' });
    }
    items.push({ kind: 'toggle', id: 'text', label: 'Text view', icon: 'list', pressed: textShown }, aboutItem());
    nendo.ui.setToolbar(items).catch(error => leaveNativeChrome(describe(error)));
  }

  // A Nendo that refuses the declaration leaves the view its own controls, and says why.
  function leaveNativeChrome(reason) {
    if (!nativeChrome) return;
    nativeChrome = false;
    document.documentElement.classList.remove('native-chrome', 'about-shown');
    nendo.ui.setToolbar([]).catch(() => undefined);
    element('selection').textContent = `Nendo could not show this graph's controls, so the graph shows its own: ${reason}`;
  }

  function runCommand({ id, value }) {
    if (id === 'zoom-in') zoom(1.25);
    else if (id === 'zoom-out') zoom(.8);
    else if (id === 'fit') fitAgain();
    else if (id === 'text') setTextShown(value === true);
    else if (id === 'about') setAboutShown(value === true);
  }
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && aboutShown) setAboutShown(false); });

  canvas.addEventListener('contextmenu', event => {
    if (!nativeChrome || !nendo.has('ui.showMenu')) return;
    const group = event.target.closest('.node');
    if (group === null) return;
    event.preventDefault();
    let at = event;
    // The keyboard's menu key names no point: the menu opens at the record.
    if (event.clientX === 0 && event.clientY === 0) {
      const box = group.getBoundingClientRect();
      at = { x: box.left + 8, y: box.bottom - 4 };
    }
    const id = group.dataset.id;
    highlight(id);
    nendo.ui.showMenu([{ id: 'open', label: 'Open record', icon: 'external' }], at)
      .then(pick => { if (pick?.id === 'open') select(id); })
      .catch(error => { element('selection').textContent = describe(error); });
  });

  function adoptNativeChrome() {
    if (typeof nendo.has !== 'function' || !nendo.has('ui.setToolbar')) return;
    nativeChrome = true;
    document.documentElement.classList.add('native-chrome');
    nendo.on('command', command => { try { runCommand(command); } catch (error) { element('selection').textContent = describe(error); } });
    declareToolbar();
  }

  if (nendo === undefined) {
    element('summary').textContent = 'This graph runs inside Nendo. Open the screen that shows it.';
    return;
  }
  nendo.ready.then(context => {
    adoptNativeChrome();
    applyTheme(nendo.ui.theme);
    nendo.on('theme', applyTheme);
    // A new context can name other fields or another record type: read again under it.
    nendo.on('context', next => { applyTheme(next.theme); schedule(); });
    nendo.on('changes', schedule);
    return read();
  }).catch(error => { setSummary(`This graph could not start. ${describe(error)}`, true); });
})();
