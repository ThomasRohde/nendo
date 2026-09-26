(() => {
  'use strict';
  // Work items as nodes and what blocks what as links, laid out by the Eclipse Layout Kernel:
  // elkjs, vendored under vendor/elkjs and run in a Web Worker so a large layout never stalls
  // the view. Left to right is the order the work has to happen in, and every link is routed
  // around the items. Items can be grouped by any reference or choice field of their record
  // type, filtered by status and searched; items linked to nothing wait on a shelf below the
  // drawing rather than stretching it. Everything arrives through window.nendo (ADR-0013): the
  // graph from nendo.view.loadGraph, field names and choices from nendo.schema.describe, and
  // the theme. Selecting an item asks Nendo to open it, and offers that item's record commands
  // (Plan now, Complete, ...) to run where it is, through nendo.commands.run (ADR-0013 Phase 3):
  // each at the version this view read, refused if somebody changed the item since.
  const element = id => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const nendo = window.nendo;
  const canvas = element('canvas'), drawing = element('drawing');
  const layers = { groups: element('groups'), edges: element('edges'), nodes: element('nodes') };
  const NODE_WIDTH = 232, LINE = 17, PAD = 14, GAP = 22, SHELF_GAP = 64, TITLE = 30;
  const WORKER = 'vendor/elkjs/elk-worker.min.js', LAYOUT_TIMEOUT_MS = 15000;
  const SETTINGS = 'nendo.work-dependencies.v2';
  const LABEL_FONT = '600 13px "Segoe UI Variable", "Segoe UI", sans-serif';
  // A status is drawn in its choice's own tone. A choice without one falls back to the planner's
  // names for the same states, and anything else is neutral rather than guessed at.
  const TONES = { inbox: 'grey', ready: 'blue', doing: 'violet', blocked: 'red', review: 'amber', done: 'green', dropped: 'grey' };
  const TONE_NAMES = new Set(['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'grey']);

  let all = { nodes: [], edges: [] };
  let shown = { nodes: [], edges: [], linked: new Set(), hidden: 0 };
  let fields = { status: null, groups: [] };
  let commands = [], acting = false;
  let selected = null, focusing = false, chaining = false, query = '';
  let chain = { nodes: new Set(), edges: new Set(), order: [] };
  let extent = { x: 0, y: 0, width: 800, height: 500 };
  let scale = 1, offsetX = 0, offsetY = 0, drag = null;
  let loaded = false, latest = 0, pending = null, run = 0;
  let elk = null, elkFailure = null, pendingHide = null;
  const component = new Map(), cyclic = new Set(), outgoing = new Map(), incoming = new Map(), boxes = new Map();
  const settings = { groupBy: '', hidden: [], linkedOnly: false };
  const remembered = loadSettings();

  function shape(name, attributes, text) {
    const item = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function describe(error) { return error instanceof Error && error.message ? error.message : String(error); }
  const round = value => Math.round(value * 10) / 10;
  const byLabel = (a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // What this person chose here, kept on this device. The view's origin is this package in this
  // file, so each file keeps its own choices.
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS) ?? 'null');
      if (saved === null || typeof saved !== 'object') return false;
      if (typeof saved.groupBy === 'string') settings.groupBy = saved.groupBy;
      if (Array.isArray(saved.hidden)) settings.hidden = saved.hidden.filter(value => typeof value === 'string');
      if (typeof saved.linkedOnly === 'boolean') settings.linkedOnly = saved.linkedOnly;
      return true;
    } catch { return false; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS, JSON.stringify(settings)); } catch { /* Storage refused: the choice lasts this session. */ }
  }
  // The view's configuration gives the first-time defaults: { "groupBy": fieldId,
  // "hideStatuses": [name or option ID], "linkedOnly": true }. A choice made here wins.
  function applyConfiguration(configuration) {
    if (remembered || configuration === null || typeof configuration !== 'object') return;
    if (typeof configuration.groupBy === 'string') settings.groupBy = configuration.groupBy;
    if (typeof configuration.linkedOnly === 'boolean') settings.linkedOnly = configuration.linkedOnly;
    if (Array.isArray(configuration.hideStatuses)) pendingHide = configuration.hideStatuses.filter(value => typeof value === 'string');
  }

  // Labels wrap to two lines inside a fixed width, and the second line ends in an ellipsis
  // when there is more. Measured with the font the label is drawn in.
  const ruler = document.createElement('canvas').getContext('2d');
  function width(text) { ruler.font = LABEL_FONT; return ruler.measureText(text).width; }
  function clip(text, max) {
    if (width(text) <= max) return text;
    let low = 0, high = text.length;
    while (low < high) { const middle = (low + high + 1) >> 1; if (width(text.slice(0, middle) + '…') <= max) low = middle; else high = middle - 1; }
    return text.slice(0, low).trimEnd() + '…';
  }
  function wrap(label) {
    const max = NODE_WIDTH - PAD * 2, words = label.trim().split(/\s+/).filter(Boolean);
    let first = '', index = 0;
    for (; index < words.length; index += 1) {
      const next = first === '' ? words[index] : first + ' ' + words[index];
      if (width(next) > max) break;
      first = next;
    }
    if (first === '') return [clip(label.trim(), max)];
    return index === words.length ? [first] : [first, clip(words.slice(index).join(' '), max)];
  }
  const heightOf = node => node.lines.length > 1 ? 80 : 62;

  // --- Reading ---------------------------------------------------------------------------

  function readFields(schema, context) {
    // The record commands the file defines for these work items: the same ones the record page
    // offers, by the IDs schema.describe lists.
    commands = (schema.commands ?? []).filter(command => command.entityId === context.entityId && typeof command.id === 'string');
    const entity = schema.entities.find(candidate => candidate.entityId === context.entityId);
    const status = entity?.fields.find(field => field.fieldId === context.bindings.statusFieldId) ?? null;
    fields = {
      status: status === null ? null : { fieldId: status.fieldId, displayName: status.displayName,
        choices: (status.choices ?? []).filter(choice => !choice.retired) },
      groups: (entity?.fields ?? [])
        .filter(field => !field.calculated && (field.storageKind === 'reference' || (field.choices?.length ?? 0) > 0))
        .map(field => ({ fieldId: field.fieldId, displayName: field.displayName, kind: field.storageKind === 'reference' ? 'reference' : 'choice',
          choices: field.choices ?? [] })),
    };
    if (pendingHide !== null && fields.status !== null) {
      const wanted = new Set(pendingHide.map(value => value.toLowerCase()));
      settings.hidden = fields.status.choices.filter(choice => wanted.has(choice.id.toLowerCase()) || wanted.has(choice.displayName.toLowerCase())).map(choice => choice.id);
      pendingHide = null;
    }
  }

  // A field's value as a person reads it: a reference by its target's label, a choice by its
  // name, a number by its exact digits. Null when the record has none.
  function display(record, fieldId) {
    const label = record.labels?.[fieldId];
    if (typeof label === 'string') return label;
    const value = record.values?.[fieldId];
    if (value === null || value === undefined) return null;
    return record.exact?.[fieldId] ?? (typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  function project(graph) {
    const statusFieldId = nendo.context.bindings.statusFieldId;
    return {
      nodes: graph.nodes.map(node => {
        const label = node.label || '(untitled)';
        const raw = statusFieldId === null ? null : node.record.values?.[statusFieldId] ?? null;
        const choice = raw === null ? null : fields.status?.choices.find(candidate => candidate.id === raw) ?? null;
        const status = raw === null ? null : choice?.displayName ?? display(node.record, statusFieldId);
        const tone = status === null ? null : TONE_NAMES.has(choice?.tone) ? choice.tone : TONES[status.toLowerCase()] ?? 'grey';
        return { id: node.id, entityId: node.record.entityId, label, statusId: raw === null ? null : String(raw), status, tone,
          record: node.record, lines: wrap(label) };
      }),
      edges: graph.edges.map(edge => ({ id: edge.id, sourceId: edge.source, targetId: edge.target })),
    };
  }

  // --- What is shown, and what it means --------------------------------------------------

  function filter() {
    const hide = new Set(settings.hidden);
    let nodes = all.nodes.filter(node => node.statusId === null || !hide.has(node.statusId));
    const present = new Set(nodes.map(node => node.id));
    const edges = all.edges.filter(edge => present.has(edge.sourceId) && present.has(edge.targetId));
    const linked = new Set(edges.flatMap(edge => [edge.sourceId, edge.targetId]));
    if (settings.linkedOnly) nodes = nodes.filter(node => linked.has(node.id));
    return { nodes, edges, linked, hidden: all.nodes.length - nodes.length };
  }

  function analyse() {
    outgoing.clear(); incoming.clear();
    // Adjacency is by distinct item, not by link record: two records both saying A blocks B are
    // two links to draw and one thing to say about B.
    const after = new Map(shown.nodes.map(node => [node.id, new Set()]));
    const before = new Map(shown.nodes.map(node => [node.id, new Set()]));
    for (const edge of shown.edges) { after.get(edge.sourceId).add(edge.targetId); before.get(edge.targetId).add(edge.sourceId); }
    for (const node of shown.nodes) { outgoing.set(node.id, [...after.get(node.id)]); incoming.set(node.id, [...before.get(node.id)]); }
    components();
    chain = longestChain();
  }

  /**
   * Tarjan's strongly connected components, so a cycle is named exactly rather than inferred
   * from "whatever the ordering could not settle" -- which also catches everything merely
   * standing behind a cycle. Iterative: a planner chain can be deep and a frame has no stack
   * to spare.
   */
  function components() {
    component.clear(); cyclic.clear();
    const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
    let next = 0, group = 0;
    for (const root of shown.nodes) {
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

  const inCycle = edge => edge.sourceId === edge.targetId || component.get(edge.sourceId) === component.get(edge.targetId);

  /**
   * The longest run of work that has to happen one item after another: the longest path once
   * each cycle's own links are set aside, counted in items. Ties go to the first in reading
   * order, so the same file always marks the same chain.
   */
  function longestChain() {
    const forward = new Map(shown.nodes.map(node => [node.id, new Set()]));
    const degree = new Map(shown.nodes.map(node => [node.id, 0]));
    for (const edge of shown.edges) {
      if (inCycle(edge) || forward.get(edge.sourceId).has(edge.targetId)) continue;
      forward.get(edge.sourceId).add(edge.targetId);
      degree.set(edge.targetId, degree.get(edge.targetId) + 1);
    }
    const length = new Map(shown.nodes.map(node => [node.id, 1])), previous = new Map();
    const queue = shown.nodes.filter(node => degree.get(node.id) === 0).map(node => node.id);
    for (let at = 0; at < queue.length; at += 1) {
      const id = queue[at];
      for (const next of forward.get(id)) {
        if (length.get(id) + 1 > length.get(next)) { length.set(next, length.get(id) + 1); previous.set(next, id); }
        degree.set(next, degree.get(next) - 1);
        if (degree.get(next) === 0) queue.push(next);
      }
    }
    let end = null;
    for (const node of shown.nodes) if (end === null || length.get(node.id) > length.get(end)) end = node.id;
    const order = [];
    for (let id = end; id !== null && id !== undefined; id = previous.get(id)) order.unshift(id);
    if (order.length < 2) return { nodes: new Set(), edges: new Set(), order: [] };
    const steps = new Set(order.slice(1).map((id, at) => order[at] + '\u0000' + id));
    return { nodes: new Set(order), order,
      edges: new Set(shown.edges.filter(edge => steps.has(edge.sourceId + '\u0000' + edge.targetId)).map(edge => edge.id)) };
  }

  function reachable(from, map) {
    const seen = new Set(), queue = [from];
    while (queue.length !== 0) {
      for (const next of map.get(queue.pop()) ?? []) if (!seen.has(next) && next !== from) { seen.add(next); queue.push(next); }
    }
    return seen;
  }

  // --- Layout -----------------------------------------------------------------------------

  function groupField() { return fields.groups.find(field => field.fieldId === settings.groupBy) ?? null; }

  function groupOf(node, field) {
    const value = node.record.values?.[field.fieldId];
    if (value === null || value === undefined || value === '') return { key: '', label: `No ${field.displayName.toLowerCase()}`, rank: Infinity };
    if (field.kind === 'reference') return { key: String(value), label: node.record.labels?.[field.fieldId] ?? String(value), rank: 0 };
    const at = field.choices.findIndex(choice => choice.id === value);
    return { key: String(value), label: at < 0 ? String(value) : field.choices[at].displayName, rank: at < 0 ? field.choices.length : at };
  }
  const byGroup = (a, b) => a.rank - b.rank || a.label.localeCompare(b.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  function sections(nodes, field) {
    const byKey = new Map();
    for (const node of [...nodes].sort(byLabel)) {
      const group = groupOf(node, field);
      if (!byKey.has(group.key)) byKey.set(group.key, { ...group, members: [] });
      byKey.get(group.key).members.push(node);
    }
    return [...byKey.values()].sort(byGroup);
  }

  function aspect() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    return width > 0 && height > 0 ? Math.min(3, Math.max(.6, width / height)) : 1.6;
  }

  function engine() {
    if (elk !== null) return elk;
    if (typeof window.ELK !== 'function') throw new Error('The layout engine did not load.');
    elk = new window.ELK({ workerUrl: WORKER });
    return elk;
  }
  function withTimeout(promise, milliseconds) {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The layout took longer than ${milliseconds / 1000} s.`)), milliseconds); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }

  /**
   * The linked items through ELK's layered algorithm: layers left to right, links routed at
   * right angles around the items, and each group a box of its own that links cross. Every
   * coordinate comes back relative to the whole drawing.
   */
  async function elkLayout(nodes, edges, field) {
    const layoutOptions = {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64', 'elk.spacing.nodeNode': '22',
      'elk.layered.spacing.edgeNodeBetweenLayers': '18', 'elk.spacing.edgeNode': '16', 'elk.spacing.edgeEdge': '10',
      'elk.spacing.componentComponent': '48', 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.aspectRatio': aspect().toFixed(2),
      'elk.padding': '[top=8,left=8,bottom=8,right=8]', 'elk.json.shapeCoords': 'ROOT', 'elk.json.edgeCoords': 'ROOT',
    };
    const leaf = node => ({ id: node.id, width: NODE_WIDTH, height: heightOf(node) });
    const groups = new Map();
    let children;
    if (field === null) children = [...nodes].sort(byLabel).map(leaf);
    else {
      layoutOptions['elk.hierarchyHandling'] = 'INCLUDE_CHILDREN';
      children = sections(nodes, field).map((section, index) => {
        const id = '\u0001group\u0001' + index;
        groups.set(id, section);
        return { id, layoutOptions: { 'elk.padding': `[top=${TITLE + 14},left=16,bottom=16,right=16]` }, children: section.members.map(leaf) };
      });
    }
    const graph = { id: '\u0001root', layoutOptions, children,
      edges: edges.map(edge => ({ id: edge.id, sources: [edge.sourceId], targets: [edge.targetId] })) };
    const result = await withTimeout(engine().layout(graph), LAYOUT_TIMEOUT_MS);
    const placed = { engine: 'elk', width: result.width ?? 0, height: result.height ?? 0, nodes: new Map(), groups: [], routes: new Map() };
    for (const child of result.children ?? []) {
      const section = groups.get(child.id);
      if (section === undefined) { placed.nodes.set(child.id, { x: child.x, y: child.y, width: child.width, height: child.height }); continue; }
      placed.groups.push({ key: section.key, label: section.label, count: section.members.length, x: child.x, y: child.y, width: child.width, height: child.height, part: 'diagram' });
      for (const inner of child.children ?? []) placed.nodes.set(inner.id, { x: inner.x, y: inner.y, width: inner.width, height: inner.height });
    }
    for (const edge of result.edges ?? []) {
      const section = edge.sections?.[0];
      if (section) placed.routes.set(edge.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(point => ({ x: point.x, y: point.y })));
    }
    if (nodes.some(node => !placed.nodes.has(node.id)) || edges.some(edge => !placed.routes.has(edge.id)))
      throw new Error('The layout left something unplaced.');
    return placed;
  }

  /**
   * Used only when ELK cannot run: an item one column right of the last thing that blocks it,
   * and links routed at right angles, backwards ones underneath. Groups are not drawn.
   */
  function simpleLayout(nodes, edges) {
    const ids = new Set(nodes.map(node => node.id));
    const degree = new Map(nodes.map(node => [node.id, 0])), forward = new Map(nodes.map(node => [node.id, []]));
    for (const edge of edges) {
      if (inCycle(edge) || !ids.has(edge.sourceId) || !ids.has(edge.targetId)) continue;
      forward.get(edge.sourceId).push(edge.targetId); degree.set(edge.targetId, degree.get(edge.targetId) + 1);
    }
    const layer = new Map(nodes.map(node => [node.id, 0]));
    const queue = nodes.filter(node => degree.get(node.id) === 0).map(node => node.id);
    for (let at = 0; at < queue.length; at += 1) {
      for (const target of forward.get(queue[at])) {
        layer.set(target, Math.max(layer.get(target), layer.get(queue[at]) + 1));
        degree.set(target, degree.get(target) - 1);
        if (degree.get(target) === 0) queue.push(target);
      }
    }
    const placed = { engine: 'simple', width: 0, height: 0, nodes: new Map(), groups: [], routes: new Map() };
    const columns = new Map();
    for (const node of [...nodes].sort(byLabel)) {
      const at = layer.get(node.id), y = columns.get(at) ?? 0;
      placed.nodes.set(node.id, { x: at * (NODE_WIDTH + 72), y, width: NODE_WIDTH, height: heightOf(node) });
      columns.set(at, y + heightOf(node) + GAP);
    }
    for (const box of placed.nodes.values()) { placed.width = Math.max(placed.width, box.x + box.width); placed.height = Math.max(placed.height, box.y + box.height); }
    const below = placed.height + 18;
    for (const edge of edges) {
      const s = placed.nodes.get(edge.sourceId), t = placed.nodes.get(edge.targetId);
      if (edge.sourceId === edge.targetId) {
        placed.routes.set(edge.id, [{ x: s.x + 60, y: s.y }, { x: s.x + 60, y: s.y - 16 }, { x: s.x + s.width - 60, y: s.y - 16 }, { x: s.x + s.width - 60, y: s.y }]);
      } else if (t.x > s.x) {
        const middle = (s.x + s.width + t.x) / 2, from = s.y + s.height / 2, to = t.y + t.height / 2;
        placed.routes.set(edge.id, [{ x: s.x + s.width, y: from }, { x: middle, y: from }, { x: middle, y: to }, { x: t.x, y: to }]);
      } else {
        placed.routes.set(edge.id, [{ x: s.x + s.width / 2, y: s.y + s.height }, { x: s.x + s.width / 2, y: below },
          { x: t.x + t.width / 2, y: below }, { x: t.x + t.width / 2, y: t.y + t.height }]);
      }
    }
    if (edges.length !== 0) placed.height = below + 8;
    return placed;
  }

  /** Items linked to nothing, on a shelf below the drawing: a grid, grouped the same way. */
  function shelve(placed, nodes, field) {
    if (nodes.length === 0) return;
    const cell = NODE_WIDTH + GAP;
    const top = placed.nodes.size === 0 ? 0 : placed.height + SHELF_GAP;
    const target = Math.max(placed.width, Math.sqrt(nodes.length * cell * 84 * aspect()));
    const columns = Math.max(1, Math.floor((target + GAP) / cell));
    placed.shelf = { y: top, titled: placed.nodes.size !== 0 };
    let y = top + (placed.shelf.titled ? 12 : 0);
    const parts = field === null ? [{ key: null, label: null, members: [...nodes].sort(byLabel) }] : sections(nodes, field);
    for (const part of parts) {
      const inset = part.label === null ? 0 : 16, head = part.label === null ? 0 : TITLE + 10;
      let rowTop = y + inset + head, rowHeight = 0, used = 0;
      part.members.forEach((node, at) => {
        const column = at % columns;
        if (column === 0 && at !== 0) { rowTop += rowHeight + GAP; rowHeight = 0; }
        placed.nodes.set(node.id, { x: inset + column * cell, y: rowTop, width: NODE_WIDTH, height: heightOf(node) });
        rowHeight = Math.max(rowHeight, heightOf(node));
        used = Math.max(used, column + 1);
      });
      const bottom = rowTop + rowHeight + inset;
      if (part.label !== null) {
        placed.groups.push({ key: part.key, label: part.label, count: part.members.length, x: 0, y, width: used * cell - GAP + inset * 2, height: bottom - y, part: 'shelf' });
      }
      placed.width = Math.max(placed.width, used * cell - GAP + inset * 2);
      y = bottom + GAP;
    }
    placed.height = y - GAP;
  }

  async function arrange() {
    const linked = shown.nodes.filter(node => shown.linked.has(node.id));
    const loose = shown.nodes.filter(node => !shown.linked.has(node.id));
    const field = groupField();
    let placed;
    if (linked.length === 0) placed = { engine: 'none', width: 0, height: 0, nodes: new Map(), groups: [], routes: new Map() };
    else {
      try {
        placed = await elkLayout(linked, shown.edges, field);
        elkFailure = null;
      } catch (error) {
        elkFailure = describe(error);
        // A worker that failed or stalled is ended; the next layout starts a fresh one.
        try { elk?.terminateWorker(); } catch { /* Already gone. */ }
        elk = null;
        placed = simpleLayout(linked, shown.edges);
      }
    }
    shelve(placed, loose, field);
    return placed;
  }

  // --- Drawing ----------------------------------------------------------------------------

  function pathOf(points) {
    return points.map((point, at) => `${at === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`).join(' ');
  }

  function draw(placed) {
    document.documentElement.dataset.layout = placed.engine;
    for (const layer of Object.values(layers)) layer.replaceChildren();
    boxes.clear();
    let minX = 0, minY = 0, maxX = placed.width, maxY = placed.height;
    for (const group of placed.groups) {
      const item = shape('g', { class: 'group ' + group.part, 'data-group': group.key });
      item.append(shape('rect', { x: round(group.x), y: round(group.y), width: round(group.width), height: round(group.height), rx: 16, class: 'group-box' }),
        shape('text', { x: round(group.x + 16), y: round(group.y + 26), class: 'group-title' }, `${group.label} · ${group.count}`));
      layers.groups.append(item);
      minX = Math.min(minX, group.x); minY = Math.min(minY, group.y);
      maxX = Math.max(maxX, group.x + group.width); maxY = Math.max(maxY, group.y + group.height);
    }
    if (placed.shelf?.titled) layers.groups.append(shape('text', { x: 0, y: round(placed.shelf.y - 10), class: 'shelf-title' }, 'Linked to nothing yet'));
    for (const edge of shown.edges) {
      const points = placed.routes.get(edge.id);
      if (points === undefined) continue;
      layers.edges.append(shape('path', { d: pathOf(points), class: inCycle(edge) ? 'edge cycle' : 'edge',
        'data-source': edge.sourceId, 'data-target': edge.targetId, 'data-edge-id': edge.id }));
      for (const point of points) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); }
    }
    shown.nodes.forEach(node => {
      const box = placed.nodes.get(node.id);
      boxes.set(node.id, box);
      const group = shape('g', {
        transform: `translate(${round(box.x)} ${round(box.y)})`, class: shown.linked.has(node.id) ? 'node' : 'node unlinked',
        tabindex: 0, role: 'button', 'aria-label': node.status === null ? node.label : `${node.label}, ${node.status}`,
        'aria-pressed': 'false', 'data-id': node.id,
      });
      group.append(shape('title', {}, node.status === null ? node.label : `${node.label} — ${node.status}`),
        shape('rect', { width: box.width, height: box.height, rx: 11 }));
      const label = shape('text', { class: 'label', x: PAD, y: 25 });
      node.lines.forEach((line, at) => label.append(shape('tspan', { x: PAD, dy: at === 0 ? 0 : LINE }, line)));
      group.append(label);
      if (node.status !== null) {
        group.append(shape('circle', { cx: 19, cy: box.height - 17, r: 5, class: 'tone tone-' + node.tone }),
          shape('text', { x: 30, y: box.height - 13, class: 'status' }, node.status.slice(0, 26)));
      }
      if (cyclic.has(node.id)) group.append(shape('text', { x: box.width - PAD, y: box.height - 13, class: 'cycle-mark', 'text-anchor': 'end' }, 'cycle'));
      group.addEventListener('click', () => select(node.id));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.id); }
        else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault(); event.stopPropagation();
          const items = [...layers.nodes.querySelectorAll('.node')], at = items.indexOf(group);
          items[(at + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
        }
      });
      group.addEventListener('focus', () => {
        // Keyboard navigation brings the whole target into view; pointer focus must not move a
        // node between pointer-down and the click it belongs to.
        if (group.matches(':focus-visible')) centre(node.id);
      });
      layers.nodes.append(group);
      maxX = Math.max(maxX, box.x + box.width); maxY = Math.max(maxY, box.y + box.height);
    });
    extent = { x: minX, y: minY, width: Math.max(320, maxX - minX), height: Math.max(200, maxY - minY) };
  }

  function paint() {
    const blockers = selected === null ? new Set() : reachable(selected, incoming);
    const blocked = selected === null ? new Set() : reachable(selected, outgoing);
    const connected = new Set([...blockers, ...blocked]);
    if (selected !== null) connected.add(selected);
    const needle = query.trim().toLowerCase();
    const labels = new Map(shown.nodes.map(node => [node.id, node.label.toLowerCase()]));
    drawing.classList.toggle('focused', focusing && selected !== null);
    drawing.classList.toggle('searching', needle !== '');
    drawing.classList.toggle('chaining', chaining && chain.order.length > 1);
    for (const node of layers.nodes.querySelectorAll('.node')) {
      const id = node.dataset.id;
      node.classList.toggle('selected', id === selected);
      node.classList.toggle('upstream', blockers.has(id));
      node.classList.toggle('downstream', blocked.has(id));
      node.classList.toggle('faded', selected !== null && !connected.has(id));
      node.classList.toggle('match', needle !== '' && (labels.get(id) ?? '').includes(needle));
      node.classList.toggle('chain', chain.nodes.has(id));
      node.setAttribute('aria-pressed', String(id === selected));
    }
    for (const edge of layers.edges.querySelectorAll('.edge')) {
      const touches = connected.has(edge.dataset.source) && connected.has(edge.dataset.target);
      edge.classList.toggle('related', selected !== null && touches);
      edge.classList.toggle('faded', selected !== null && !touches);
      edge.classList.toggle('chain', chain.edges.has(edge.dataset.edgeId));
    }
    for (const button of element('records').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === selected));
    showActions();
  }

  // --- Acting -----------------------------------------------------------------------------

  // A command is offered when Nendo lets views run them, the file is not read-only, and the
  // file defines one for these work items.
  function canAct() {
    return commands.length !== 0 && typeof nendo.has === 'function' && nendo.has('commands.run') && nendo.context?.readOnly !== true;
  }

  function showActions() {
    const box = element('actions');
    const node = selected === null ? undefined : shown.nodes.find(value => value.id === selected);
    box.hidden = node === undefined || !canAct();
    if (box.hidden) { box.replaceChildren(); return; }
    box.replaceChildren(...commands.map(command => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = command.label; button.dataset.command = command.id; button.disabled = acting;
      button.addEventListener('click', () => act(command, node.id));
      return button;
    }));
  }

  function say(text, refused = false) {
    const line = element('outcome');
    line.textContent = text;
    line.classList.toggle('refused', refused);
  }

  /**
   * Runs a record command on one work item, at the version this view last read. Nendo checks
   * the version, so an item somebody changed meanwhile is refused and left as it is; the view
   * says so and reads again. Nendo itself asks nothing first (ADR-0013): the change is in
   * History under this view's package, where the person can undo it.
   */
  async function act(command, id) {
    const node = all.nodes.find(value => value.id === id);
    if (node === undefined || acting) return;
    acting = true; showActions();
    say(`${command.label}: ${node.label}…`);
    try {
      await nendo.commands.run(command.id, node.record);
      say(`${command.label}: done for ${node.label}. Undo it in Nendo's History.`);
    } catch (error) {
      say(error?.code === 'record-version-conflict'
        ? `${node.label} changed since this view read it, so nothing was done. Reading it again.`
        : `${command.label} was not run on ${node.label}: ${describe(error)}`, true);
    } finally {
      acting = false; showActions();
      schedule();
    }
  }

  // --- Moving around ----------------------------------------------------------------------

  function transform() { drawing.setAttribute('transform', `translate(${round(offsetX)} ${round(offsetY)}) scale(${Math.round(scale * 1000) / 1000})`); }
  function fit() {
    const bounds = canvas.getBoundingClientRect();
    // The Workbench lays out and sizes this frame after the page loads, so an early fit can
    // measure zero and put every item off-screen. Skip until the canvas has a real size.
    if (bounds.width < 1 || bounds.height < 1) return;
    const margin = 24;
    scale = Math.min(1.1, Math.max(.05, Math.min((bounds.width - margin * 2) / extent.width, (bounds.height - margin * 2) / extent.height)));
    offsetX = (bounds.width - extent.width * scale) / 2 - extent.x * scale;
    offsetY = (bounds.height - extent.height * scale) / 2 - extent.y * scale;
    transform();
  }
  function refit() { requestAnimationFrame(() => requestAnimationFrame(() => { if (loaded && !canvas.hidden) fit(); })); }
  function zoom(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    const next = Math.min(4, Math.max(.05, scale * factor));
    offsetX = x - (x - offsetX) * next / scale; offsetY = y - (y - offsetY) * next / scale;
    scale = next; transform();
  }
  function centre(id) {
    const box = boxes.get(id);
    if (box === undefined) return;
    offsetX = canvas.clientWidth / 2 - (box.x + box.width / 2) * scale;
    offsetY = canvas.clientHeight / 2 - (box.y + box.height / 2) * scale;
    transform();
  }
  function visible(id) {
    const box = boxes.get(id);
    if (box === undefined) return false;
    const left = offsetX + box.x * scale, top = offsetY + box.y * scale;
    return left >= 0 && top >= 0 && left + box.width * scale <= canvas.clientWidth && top + box.height * scale <= canvas.clientHeight;
  }

  // --- Saying things ----------------------------------------------------------------------

  function highlight(id) {
    selected = id;
    const node = shown.nodes.find(value => value.id === id);
    const blockers = incoming.get(id).length, blocks = outgoing.get(id).length;
    const total = reachable(id, outgoing).size;
    element('selection').textContent = `${node.label} · blocked by ${blockers} · blocks ${blocks}`
      + (total > blocks ? ` (${total} in all downstream)` : '')
      + (cyclic.has(id) ? ' · in a dependency cycle' : blockers === 0 ? ' · nothing is blocking it' : '');
    paint();
  }

  function select(id) {
    if (!boxes.has(id)) return;
    highlight(id);
    const node = shown.nodes.find(value => value.id === id);
    nendo.ui.openRecord(node.entityId, id).catch(error => {
      if (selected === id) element('selection').textContent = `${node.label} · Nendo could not open it: ${describe(error)}`;
    });
  }

  function sayChain() {
    if (chain.order.length < 2) { element('selection').textContent = 'No two items here have to happen one after the other.'; return; }
    const labels = new Map(shown.nodes.map(node => [node.id, node.label]));
    element('selection').textContent = `Longest chain: ${chain.order.map(id => labels.get(id)).join(' → ')} · ${chain.order.length} items`;
  }

  function textView() {
    const list = element('records'); list.replaceChildren();
    const labels = new Map(shown.nodes.map(node => [node.id, node.label]));
    for (const node of shown.nodes) {
      const row = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = node.label; button.dataset.id = node.id;
      button.setAttribute('aria-pressed', String(node.id === selected));
      button.addEventListener('click', () => select(node.id)); row.append(button);
      const description = document.createElement('p');
      const blockers = incoming.get(node.id).map(id => labels.get(id)), blocks = outgoing.get(node.id).map(id => labels.get(id));
      description.textContent = `${node.status === null ? '' : node.status + ' · '}`
        + `Blocked by: ${blockers.join(', ') || 'nothing'}. Blocks: ${blocks.join(', ') || 'nothing'}.`
        + (cyclic.has(node.id) ? ' In a dependency cycle.' : '');
      row.append(description); list.append(row);
    }
  }

  function summarize() {
    const unblocked = shown.nodes.filter(node => incoming.get(node.id).length === 0).length;
    const parts = [`${shown.nodes.length} work item${shown.nodes.length === 1 ? '' : 's'}`, `${shown.edges.length} link${shown.edges.length === 1 ? '' : 's'}`];
    if (shown.nodes.length !== 0) parts.push(`${unblocked} unblocked`);
    if (cyclic.size !== 0) parts.push(`${cyclic.size} in a dependency cycle`);
    if (shown.hidden !== 0) parts.push(`${shown.hidden} hidden`);
    if (elkFailure !== null) parts.push('simple layout');
    const summary = element('summary');
    summary.textContent = parts.join(' · ');
    summary.title = elkFailure === null ? '' : `The layout engine could not run, so a simpler layout is drawn: ${elkFailure}`;
  }

  // --- Controls ---------------------------------------------------------------------------

  function buildControls() {
    const select = element('group-by');
    const choices = [['', 'None'], ...fields.groups.map(field => [field.fieldId, field.displayName])];
    if (select.options.length !== choices.length || choices.some(([value], at) => select.options[at].value !== value)) {
      select.replaceChildren(...choices.map(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; return option; }));
    }
    select.value = groupField() === null ? '' : settings.groupBy;
    const chips = element('status-chips');
    chips.replaceChildren();
    for (const choice of fields.status?.choices ?? []) {
      const label = document.createElement('label'), box = document.createElement('input');
      label.className = 'chip'; box.type = 'checkbox'; box.checked = !settings.hidden.includes(choice.id); box.dataset.status = choice.id;
      box.addEventListener('change', () => {
        settings.hidden = box.checked ? settings.hidden.filter(id => id !== choice.id) : [...new Set([...settings.hidden, choice.id])];
        saveSettings(); refresh();
      });
      label.append(box, document.createTextNode(choice.displayName));
      chips.append(label);
    }
    if ((fields.status?.choices.length ?? 0) === 0) chips.textContent = 'This view has no status field to filter by.';
    const hiddenStatuses = settings.hidden.filter(id => fields.status?.choices.some(choice => choice.id === id)).length;
    element('filter-toggle').textContent = hiddenStatuses === 0 ? 'Filter' : `Filter · ${hiddenStatuses}`;
    element('linked-toggle').setAttribute('aria-pressed', String(settings.linkedOnly));
  }

  async function relayout(keep = selected) {
    const mine = ++run;
    shown = filter();
    analyse();
    const placed = await arrange();
    if (mine !== run) return;
    selected = null;
    draw(placed);
    element('selection').textContent = 'No work item selected';
    const empty = element('empty');
    empty.hidden = shown.nodes.length !== 0;
    empty.textContent = all.nodes.length === 0 ? 'There are no work items here yet.' : 'Every work item is filtered out. Show more under Filter, or turn off Linked only.';
    summarize(); textView(); buildControls(); paint(); fit(); refit();
    if (keep !== null && boxes.has(keep)) highlight(keep);
    else if (chaining) sayChain();
  }

  // A layout asked for by a control; a failure is said in the view, never thrown.
  function refresh() {
    relayout().catch(() => { element('summary').textContent = 'These dependencies could not be displayed. Open your work items in Nendo.'; });
  }

  async function read() {
    const number = ++latest;
    let graph, schema;
    try {
      [graph, schema] = await Promise.all([nendo.view.loadGraph(), nendo.schema.describe()]);
    } catch (error) {
      if (number === latest) element('summary').textContent = `Your work items could not be read. ${describe(error)}`;
      return;
    }
    if (number !== latest) return;
    loaded = true;
    try {
      readFields(schema, nendo.context);
      all = project(graph);
      for (const edge of all.edges) {
        if (!all.nodes.some(node => node.id === edge.sourceId) || !all.nodes.some(node => node.id === edge.targetId)) throw new Error('Invalid graph');
      }
      await relayout();
    } catch {
      element('summary').textContent = 'These dependencies could not be displayed. Open your work items in Nendo.';
    }
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

  element('zoom-in').addEventListener('click', () => zoom(1.25));
  element('zoom-out').addEventListener('click', () => zoom(.8));
  element('reset').addEventListener('click', fit);
  element('focus-toggle').addEventListener('click', () => {
    focusing = !focusing;
    element('focus-toggle').setAttribute('aria-pressed', String(focusing));
    paint();
  });
  element('chain-toggle').addEventListener('click', () => {
    chaining = !chaining;
    element('chain-toggle').setAttribute('aria-pressed', String(chaining));
    // The chain takes the line the selection used; a selection made after it takes it back.
    if (chaining) { selected = null; sayChain(); }
    else element('selection').textContent = 'No work item selected';
    paint();
  });
  element('linked-toggle').addEventListener('click', () => { settings.linkedOnly = !settings.linkedOnly; saveSettings(); refresh(); });
  element('group-by').addEventListener('change', () => { settings.groupBy = element('group-by').value; saveSettings(); refresh(); });
  element('filter-toggle').addEventListener('click', () => {
    const show = element('filters').hidden;
    element('filters').hidden = !show;
    element('filter-toggle').setAttribute('aria-expanded', String(show));
    refit();
  });
  const find = element('find');
  find.addEventListener('input', () => { query = find.value; paint(); });
  find.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const needle = query.trim().toLowerCase();
      const match = needle === '' ? undefined : shown.nodes.find(node => node.label.toLowerCase().includes(needle));
      if (match === undefined) return;
      select(match.id);
      if (!visible(match.id)) centre(match.id);
    } else if (event.key === 'Escape') { find.value = ''; query = ''; paint(); }
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
    else if (event.key === '0') fit();
    else if (event.key === 'ArrowLeft') { offsetX += 40; transform(); }
    else if (event.key === 'ArrowRight') { offsetX -= 40; transform(); }
    else if (event.key === 'ArrowUp') { offsetY += 40; transform(); }
    else if (event.key === 'ArrowDown') { offsetY -= 40; transform(); }
    else return;
    event.preventDefault();
  });
  new ResizeObserver(() => { if (loaded && !canvas.hidden) fit(); }).observe(canvas);
  window.addEventListener('pagehide', () => { try { elk?.terminateWorker(); } catch { /* Already gone. */ } });
  if (nendo === undefined) {
    element('summary').textContent = 'This view runs inside Nendo. Open the screen that shows it.';
    return;
  }
  nendo.ready.then(context => {
    document.documentElement.lang = context.locale || 'en';
    applyConfiguration(context.configuration);
    applyTheme(nendo.ui.theme);
    nendo.on('theme', applyTheme);
    // A new context can name other fields or another record type: read again under it.
    nendo.on('context', next => { applyTheme(next.theme); schedule(); });
    nendo.on('changes', schedule);
    return read();
  }).catch(error => { element('summary').textContent = `This view could not start. ${describe(error)}`; });
})();
