// The garden drawn as a living graph with d3 (vendor/d3.min.js, loaded before this module):
// a force simulation lays the notes out, the wheel and a drag on the background zoom and pan,
// a drag on a note moves it and the rest follow, hovering a note lights it and its neighbours
// and dims the rest, and labels fade in as you zoom. A name is never drawn smaller than LABEL_PX
// on the screen, however far the drawing is zoomed out, and never over another name: where two
// would meet, the one that matters less (lit, found, a landmark, then by links) waits until there
// is room (G-015). Colours are the theme's tokens, so a theme change needs no redraw. The same drawing is the graph screen and the local graph under a note.
// The local graph (compact) is stretched to its box rather than zoomed: each axis spreads the
// layout over the room it has, so a wide box is used across its width and the dots and names
// stay the size of the page's text.
//
//   createGraph(host, { kit, colour, onOpen, onContext, compact, label }) -> {
//     update(data, { focus }), setOptions({ arrows, spread, query }), fit(), highlight(id), select(ids), state(), stop() }

import { radius } from './graph-data.mjs';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPREAD = { tight: 0.7, normal: 1, loose: 1.5 };
// The size a name is read at on the screen, in CSS pixels, and the size the stylesheet draws it at.
export const LABEL_PX = 12;
const DRAWN_PX = 11;
const shortTitle = d => d.title.length > 42 ? `${d.title.slice(0, 40)}…` : d.title;

export function createGraph(host, { kit, colour = () => 'var(--nendo-tone-grey)', onOpen = () => undefined, onContext = null, compact = false, label = 'Notes and their links' } = {}) {
  const d3 = window.d3;
  if (!d3?.forceSimulation) throw Error('d3 did not load.');
  const svg = d3.select(host).append('svg').attr('class', 'graph-svg').attr('role', 'group').attr('aria-label', label);
  svg.append('defs').append('marker').attr('id', `arrow-${Math.random().toString(36).slice(2, 8)}`).attr('viewBox', '0 0 10 10')
    .attr('refX', 10).attr('refY', 5).attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto-start-reverse')
    .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('class', 'arrow-head');
  const arrowId = svg.select('marker').attr('id');
  const viewport = svg.append('g').attr('class', 'viewport');
  const linkLayer = viewport.append('g').attr('class', 'links');
  const nodeLayer = viewport.append('g').attr('class', 'nodes');

  let nodes = [], links = [], neighbours = new Map(), focus = null, hovered = null, lit = null, dragging = false, hubs = new Set();
  // The names in the order they claim room, and the size they are drawn at in the drawing's units.
  let labelOrder = [], labelSize = DRAWN_PX;
  let transform = d3.zoomIdentity, width = 300, height = 200, firstLayout = true;
  // The stretch of each axis, from the layout's units to the drawing's; 1 on the graph screen.
  let sx = 1, sy = 1, arranged = false;
  const size = d => radius(d, { compact });
  const px = d => d.x * sx, py = d => d.y * sy;
  const options = { arrows: false, spread: 'normal', query: '', ids: null, only: null };

  const simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id(d => d.id).distance(l => (l.type === 'tag' ? 45 : 75) * SPREAD[options.spread]).strength(0.5))
    .force('charge', d3.forceManyBody().strength(() => -200 * SPREAD[options.spread]).distanceMax(700))
    .force('x', d3.forceX(0).strength(compact ? 0.09 : 0.045))
    .force('y', d3.forceY(0).strength(compact ? 0.09 : 0.045))
    // A note keeps room for its label as well as its dot, so names do not run into each other.
    .force('collide', d3.forceCollide(d => compact ? Math.max(size(d) + 6, Math.min(48, d.title.length * 2.2)) : Math.max(size(d) + 8, Math.min(70, d.title.length * 3.2))).strength(0.8))
    .on('tick', ticked)
    // The drawing frames itself again once it has settled, unless the person has moved it.
    .on('end', () => { if (!arranged) fit(); })
    // It counts as settled sooner than d3's default (0.001): what is left below 0.02 moves a note
    // by less than a pixel, and the frame waits for the end.
    .alphaMin(0.02)
    .stop();
  // Where a new layout starts to be seen: most of it runs out of sight first, so it is framed
  // close to where it settles and only the last of the motion plays.
  const SHOWN_FROM = 0.15;

  const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', event => {
    if (event.sourceEvent) arranged = true;
    transform = event.transform;
    viewport.attr('transform', transform);
    sizeLabels();
    fadeLabels();
  });
  svg.call(zoom).on('dblclick.zoom', null);

  const drag = d3.drag()
    .subject((event, d) => ({ x: px(d), y: py(d) }))
    .on('start', (event, d) => {
      dragging = true;
      arranged = true;
      if (!event.active) simulation.alphaTarget(0.25).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on('drag', (event, d) => { d.fx = event.x / sx; d.fy = event.y / sy; })
    .on('end', (event, d) => {
      dragging = false;
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
      if (hovered !== d.id) highlight(null);
    });

  // Size the drawing to its host, with (0, 0) at the centre where the forces pull.
  const resize = () => {
    const box = host.getBoundingClientRect();
    width = Math.max(120, box.width); height = Math.max(120, box.height);
    svg.attr('viewBox', [-width / 2, -height / 2, width, height].join(' '));
    // A drawing shown after being hidden measures its names again: hidden, they measured nothing.
    if (nodes.length) { sizeLabels({ again: true }); placeLabels(); }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const keys = kit?.roving ? kit.roving(host, { items: '.node', orientation: 'spatial', onActivate: item => {
    const d = d3.select(item).datum();
    if (d) onOpen(d);
  } }) : null;

  function ticked() {
    linkLayer.selectAll('line')
      .attr('x1', d => px(d.source)).attr('y1', d => py(d.source))
      .attr('x2', d => endX(d)).attr('y2', d => endY(d));
    nodeLayer.selectAll('g.node').attr('transform', d => `translate(${px(d)},${py(d)})`);
    placeLabels();
  }
  // With arrows, an edge stops at the rim of its target rather than its centre.
  const trim = (d, axis) => {
    const dx = px(d.target) - px(d.source), dy = py(d.target) - py(d.source), length = Math.hypot(dx, dy) || 1;
    const r = options.arrows ? size(d.target) + 2 : 0;
    return axis === 'x' ? px(d.target) - dx / length * r : py(d.target) - dy / length * r;
  };
  const endX = d => trim(d, 'x'), endY = d => trim(d, 'y');

  function update(data, { focus: centre = null, refit = false } = {}) {
    focus = centre;
    neighbours = data.neighbours ?? new Map();
    const previous = new Map(nodes.map(node => [node.id, node]));
    nodes = data.nodes.map(node => {
      const old = previous.get(node.id);
      if (old) return Object.assign(old, node);
      // A new node starts beside a neighbour that is already placed, so the drawing grows in place.
      const anchor = [...(neighbours.get(node.id) ?? [])].map(id => previous.get(id)).find(Boolean);
      const angle = Math.random() * Math.PI * 2;
      return { ...node, x: (anchor?.x ?? 0) + Math.cos(angle) * 30, y: (anchor?.y ?? 0) + Math.sin(angle) * 30 };
    });
    links = data.links.map(link => ({ ...link }));

    const line = linkLayer.selectAll('line').data(links, d => d.id);
    line.exit().remove();
    line.enter().append('line').merge(linkLayer.selectAll('line'))
      .attr('class', d => `edge ${d.type}${d.manual ? ' manual' : ''}`)
      .attr('marker-end', options.arrows ? `url(#${arrowId})` : null);

    const node = nodeLayer.selectAll('g.node').data(nodes, d => d.id);
    node.exit().remove();
    const entered = node.enter().append('g').attr('class', 'node').attr('tabindex', -1).attr('role', 'link');
    entered.append('circle');
    entered.append('text').attr('class', 'label');
    entered.call(drag)
      .on('pointerenter', (event, d) => { hovered = d.id; if (!dragging) highlight(d.id); })
      .on('pointerleave', () => { hovered = null; if (!dragging) highlight(null); })
      .on('focus', (event, d) => highlight(d.id))
      .on('blur', () => highlight(null))
      .on('click', (event, d) => { if (event.defaultPrevented) return; onOpen(d); })
      .on('contextmenu', (event, d) => { if (onContext) { event.preventDefault(); onContext(d, event); } });
    const all = nodeLayer.selectAll('g.node');
    // The most linked notes keep their names at any zoom, so a large garden shows its landmarks.
    const ranked = nodes.filter(n => n.type !== 'tag' && n.degree > 0).sort((a, b) => b.degree - a.degree);
    hubs = new Set(ranked.slice(0, Math.max(5, Math.round(nodes.length / 10))).map(n => n.id));
    svg.classed('dense', links.length > 150);
    all.attr('data-id', d => d.id)
      .attr('aria-label', d => `${d.title}, ${d.degree} ${d.degree === 1 ? 'link' : 'links'}`)
      .classed('tag', d => d.type === 'tag')
      .classed('current', d => d.id === focus);
    all.select('circle').attr('r', d => size(d)).style('fill', d => colour(d));
    all.select('text').text(shortTitle);
    sizeLabels({ again: true });

    simulation.nodes(nodes);
    simulation.force('link').links(links);
    if (reduced()) {
      simulation.alpha(1);
      for (let i = 0; i < 300; i += 1) simulation.tick();
      simulation.alpha(0);
      ticked();
    } else {
      const start = firstLayout ? 1 : 0.35;
      simulation.alpha(start);
      if ((firstLayout || refit) && start > SHOWN_FROM) {
        // d3's own steps, run without drawing, as many as bring it down to where it is shown.
        simulation.tick(Math.ceil(Math.log(SHOWN_FROM / start) / Math.log(1 - simulation.alphaDecay())));
        ticked();
      }
      simulation.restart();
    }
    if (firstLayout || refit) {
      firstLayout = false;
      arranged = false;
      fit(false);
    }
    search(options.query);
    fadeLabels();
    if (kit?.textAlternative) {
      kit.textAlternative(host, { label, items: nodes.map(node => ({ name: node.title,
        detail: [...(neighbours.get(node.id) ?? [])].map(id => nodes.find(n => n.id === id)?.title).filter(Boolean).join(', ') || 'no links' })) });
    }
    keys?.refresh();
  }

  /** Lights a node and its neighbours and dims the rest; null clears it. */
  function highlight(id) {
    lit = id;
    const near = id === null ? null : new Set([id, ...(neighbours.get(id) ?? [])]);
    svg.classed('focusing', id !== null);
    nodeLayer.selectAll('g.node').classed('lit', d => near !== null && near.has(d.id));
    linkLayer.selectAll('line').classed('lit', d => id !== null && (d.source.id === id || d.target.id === id));
    fadeLabels();
  }

  // ids, when given, are the notes Nendo's search found (ADR-0028): a note matches by being among
  // them, so a word in its body counts; a tag, and every node without them, matches by its name.
  // only, when given, is what the person picked out by tag or colour (select): a node matches what
  // the words and the pick both ask, and a link matches when both its ends do, so the links among
  // what is picked out stay in sight while the rest fade.
  function search(query, ids = options.ids) {
    options.query = query ?? '';
    options.ids = ids ?? null;
    const words = options.query.trim().toLowerCase(), only = options.only;
    const active = words.length > 0 || only !== null;
    const matches = d => (words.length === 0 || (options.ids !== null && d.type !== 'tag' ? options.ids.has(d.id) : d.title.toLowerCase().includes(words)))
      && (only === null || only.has(d.id));
    svg.classed('searching', active);
    nodeLayer.selectAll('g.node').classed('match', d => active && matches(d));
    linkLayer.selectAll('line').classed('match', d => active && typeof d.source === 'object' && matches(d.source) && matches(d.target));
    fadeLabels();
    return nodeLayer.selectAll('g.node.match').size();
  }

  /** Picks out a set of node IDs, or null for none; it combines with the words of a search. */
  function select(ids) {
    options.only = ids ?? null;
    return search(options.query);
  }

  // A name keeps LABEL_PX on the screen: zoomed out, it is drawn larger in the drawing's units, and it
  // sits under its dot by its own height. The local graph is stretched, not zoomed, so it keeps its size.
  let sized = null;
  function sizeLabels({ again = false } = {}) {
    labelSize = compact ? DRAWN_PX : Math.max(DRAWN_PX, LABEL_PX / transform.k);
    // A zoom past the size names keep on their own changes nothing on them.
    if (!again && sized === labelSize) return;
    sized = labelSize;
    const texts = nodeLayer.selectAll('g.node').select('text');
    if (compact) texts.attr('dy', d => size(d) + 12);
    else texts.style('font-size', d => `${d.type === 'tag' ? labelSize * 10 / 11 : labelSize}px`).style('stroke-width', `${3 * labelSize / DRAWN_PX}px`)
      .attr('dy', d => size(d) + labelSize * 1.05);
    // Where each name sits around its note, as drawn: measured once for each size, not on every frame.
    texts.each(function (d) {
      try { const box = this.getBBox(); d.labelBox = box.width > 0 ? { x: box.x, y: box.y, width: box.width, height: box.height } : null; } catch { d.labelBox = null; }
    });
  }

  // Labels show when the drawing is near enough to read them, as Obsidian fades them in; the
  // landmarks, and whatever is lit, found or current, always, as far as there is room for them.
  // Which claims room first: the note lit or current, its neighbours, what was found, the
  // landmarks, then the rest by how many links they have; a name shown a moment ago keeps its place.
  function fadeLabels() {
    const small = nodes.length <= 24;
    const base = compact || small ? 1 : Math.max(0, Math.min(1, (transform.k - 1.1) / 0.5));
    const order = [];
    nodeLayer.selectAll('g.node').each(function (d) {
      const node = this.classList;
      const rank = node.contains('current') || d.id === lit || d.id === hovered ? 0 : node.contains('lit') ? 1 : node.contains('match') ? 2 : hubs.has(d.id) ? 3 : 4;
      order.push({ d, text: this.querySelector('text'), rank, opacity: rank < 4 ? 1 : base });
    });
    order.sort((a, b) => a.rank - b.rank || (b.d.labelShown ? 1 : 0) - (a.d.labelShown ? 1 : 0) || b.d.degree - a.d.degree);
    labelOrder = order;
    placeLabels();
  }
  function placeLabels() {
    const k = compact ? 1 : transform.k, placed = [];
    const meets = box => placed.some(other => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom);
    for (const label of labelOrder) {
      const { d, text, rank } = label;
      let opacity = label.opacity;
      if (opacity > 0 && d.labelBox) {
        const x = transform.applyX(px(d)), y = transform.applyY(py(d)), b = d.labelBox;
        const box = { left: x + b.x * k - 2, right: x + (b.x + b.width) * k + 2, top: y + b.y * k - 1, bottom: y + (b.y + b.height) * k + 1 };
        if (rank > 0 && meets(box)) opacity = 0; else placed.push(box);
      }
      d.labelShown = opacity > 0;
      // Written only when it changes: this runs on every frame of a layout.
      if (text.style.opacity !== String(opacity)) text.style.opacity = String(opacity);
    }
  }

  function setOptions(next) {
    const spreadChanged = next.spread !== undefined && next.spread !== options.spread;
    Object.assign(options, Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)));
    linkLayer.selectAll('line').attr('marker-end', options.arrows ? `url(#${arrowId})` : null);
    if (spreadChanged) {
      simulation.force('link').distance(l => (l.type === 'tag' ? 45 : 75) * SPREAD[options.spread]);
      simulation.force('charge').strength(() => -200 * SPREAD[options.spread]);
      if (!reduced()) simulation.alpha(0.6).restart();
    }
    ticked();
    if (next.query !== undefined) search(next.query);
  }

  /** Frames every node, with a margin. The compact drawing is not zoomed but stretched: each axis spreads the layout over its box, leaving room for the
   *  names at the sides and under the dots, so the dots and names keep the page's size. */
  function fit(animate = true) {
    if (nodes.length === 0) return;
    svg.interrupt();
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (compact) {
      const stretch = (room, span) => span < 1 ? 1 : Math.max(0.3, Math.min(8, room / span));
      const tx = stretch(width - 240, x1 - x0), ty = stretch(height - 90, y1 - y0);
      const target = d3.zoomIdentity.translate(-(x0 + x1) / 2 * tx, -(y0 + y1) / 2 * ty + 8);
      if (animate && !reduced()) {
        svg.transition().duration(450).tween('stretch', () => {
          const ix = d3.interpolate(sx, tx), iy = d3.interpolate(sy, ty);
          return t => { sx = ix(t); sy = iy(t); ticked(); };
        }).call(zoom.transform, target);
      } else {
        sx = tx; sy = ty; ticked();
        svg.call(zoom.transform, target);
      }
      return;
    }
    // The graph screen shapes the layout to its box, a wide window drawing a wide garden: the axes
    // stretch against each other, keeping the area, by at most 2.25 to 1; then it zooms to fit, at
    // most one and a half times, so dots and names stay near the page's size.
    const span = { w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    const shape = Math.max(1 / 2.25, Math.min(2.25, (width / height) / (span.w / span.h)));
    const tx = Math.sqrt(shape), ty = 1 / Math.sqrt(shape);
    const k = Math.min(1.5, 0.92 / Math.max((span.w * tx + 120) / width, (span.h * ty + 80) / height));
    const target = d3.zoomIdentity.scale(k).translate(-(x0 + x1) / 2 * tx, -(y0 + y1) / 2 * ty);
    if (animate && !reduced()) {
      svg.transition().duration(450).tween('stretch', () => {
        const ix = d3.interpolate(sx, tx), iy = d3.interpolate(sy, ty);
        return t => { sx = ix(t); sy = iy(t); ticked(); };
      }).call(zoom.transform, target);
    } else {
      sx = tx; sy = ty; ticked();
      svg.call(zoom.transform, target);
    }
  }

  function state() {
    return { nodes: nodes.length, links: links.length, alpha: simulation.alpha(), k: transform.k, x: transform.x, y: transform.y,
      positions: Object.fromEntries(nodes.map(n => [n.id, [n.x, n.y]])) };
  }

  function stop() { simulation.stop(); observer.disconnect(); keys?.stop(); svg.remove(); }

  return { update, setOptions, fit, highlight, search, select, state, stop, zoomBy: k => svg.call(zoom.scaleBy, k) };
}
