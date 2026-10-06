// The garden drawn as a living graph with d3 (vendor/d3.min.js, loaded before this module):
// a force simulation lays the notes out, the wheel and a drag on the background zoom and pan,
// a drag on a note moves it and the rest follow, hovering a note lights it and its neighbours
// and dims the rest, and labels fade in as you zoom. Colours are the theme's tokens, so a theme
// change needs no redraw. The same drawing is the graph screen and the local graph under a note.
//
//   createGraph(host, { kit, colour, onOpen, onContext, compact, label }) -> {
//     update(data, { focus }), setOptions({ arrows, spread, query }), fit(), highlight(id), state(), stop() }

import { radius } from './graph-data.mjs';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPREAD = { tight: 0.7, normal: 1, loose: 1.5 };

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

  let nodes = [], links = [], neighbours = new Map(), focus = null, hovered = null, dragging = false;
  let transform = d3.zoomIdentity, width = 300, height = 200, firstLayout = true;
  const options = { arrows: false, spread: 'normal', query: '' };

  const simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id(d => d.id).distance(l => (l.type === 'tag' ? 45 : 75) * SPREAD[options.spread]).strength(0.5))
    .force('charge', d3.forceManyBody().strength(() => -200 * SPREAD[options.spread]).distanceMax(700))
    .force('x', d3.forceX(0).strength(compact ? 0.09 : 0.045))
    .force('y', d3.forceY(0).strength(compact ? 0.09 : 0.045))
    // A note keeps room for its label as well as its dot, so names do not run into each other.
    .force('collide', d3.forceCollide(d => compact ? radius(d) + 6 : Math.max(radius(d) + 8, Math.min(70, d.title.length * 3.2))).strength(0.8))
    .on('tick', ticked)
    .stop();

  const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', event => {
    transform = event.transform;
    viewport.attr('transform', transform);
    fadeLabels();
  });
  svg.call(zoom).on('dblclick.zoom', null);

  const drag = d3.drag()
    .on('start', (event, d) => {
      dragging = true;
      if (!event.active) simulation.alphaTarget(0.25).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
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
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => endX(d)).attr('y2', d => endY(d));
    nodeLayer.selectAll('g.node').attr('transform', d => `translate(${d.x},${d.y})`);
  }
  // With arrows, an edge stops at the rim of its target rather than its centre.
  const trim = (d, axis) => {
    const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y, length = Math.hypot(dx, dy) || 1;
    const r = options.arrows ? radius(d.target) + 2 : 0;
    return axis === 'x' ? d.target.x - dx / length * r : d.target.y - dy / length * r;
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
    all.attr('data-id', d => d.id)
      .attr('aria-label', d => `${d.title}, ${d.degree} ${d.degree === 1 ? 'link' : 'links'}`)
      .classed('tag', d => d.type === 'tag')
      .classed('current', d => d.id === focus);
    all.select('circle').attr('r', d => radius(d)).style('fill', d => colour(d));
    all.select('text').attr('dy', d => radius(d) + 12).text(d => d.title.length > 42 ? `${d.title.slice(0, 40)}…` : d.title);

    simulation.nodes(nodes);
    simulation.force('link').links(links);
    if (reduced()) {
      simulation.alpha(1);
      for (let i = 0; i < 300; i += 1) simulation.tick();
      simulation.alpha(0);
      ticked();
    } else {
      simulation.alpha(firstLayout ? 1 : 0.35).restart();
    }
    if (firstLayout || refit) {
      firstLayout = false;
      // Settle, then frame what settled; a person who zooms first keeps their view.
      const before = transform;
      setTimeout(() => { if (transform === before) fit(false); }, reduced() ? 0 : 700);
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
    const near = id === null ? null : new Set([id, ...(neighbours.get(id) ?? [])]);
    svg.classed('focusing', id !== null);
    nodeLayer.selectAll('g.node').classed('lit', d => near !== null && near.has(d.id));
    linkLayer.selectAll('line').classed('lit', d => id !== null && (d.source.id === id || d.target.id === id));
    fadeLabels();
  }

  function search(query) {
    options.query = query ?? '';
    const words = options.query.trim().toLowerCase();
    svg.classed('searching', words.length > 0);
    nodeLayer.selectAll('g.node').classed('match', d => words.length > 0 && d.title.toLowerCase().includes(words));
    fadeLabels();
    return nodeLayer.selectAll('g.node.match').size();
  }

  // Labels show when the drawing is near enough to read them, as Obsidian fades them in.
  function fadeLabels() {
    const small = nodes.length <= 24;
    const base = compact || small ? 1 : Math.max(0, Math.min(1, (transform.k - 0.6) / 0.5));
    nodeLayer.selectAll('g.node').select('text').style('opacity', function () {
      const node = this.parentNode;
      if (node.classList.contains('lit') || node.classList.contains('match') || node.classList.contains('current')) return 1;
      return base;
    });
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

  /** Frames every node, with a margin, at most at twice the natural size. */
  function fit(animate = true) {
    if (nodes.length === 0) return;
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min(2, 0.9 / Math.max((x1 - x0 + 80) / width, (y1 - y0 + 80) / height));
    const target = d3.zoomIdentity.scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    (animate && !reduced() ? svg.transition().duration(450) : svg).call(zoom.transform, target);
  }

  function state() {
    return { nodes: nodes.length, links: links.length, alpha: simulation.alpha(), k: transform.k, x: transform.x, y: transform.y,
      positions: Object.fromEntries(nodes.map(n => [n.id, [n.x, n.y]])) };
  }

  function stop() { simulation.stop(); observer.disconnect(); keys?.stop(); svg.remove(); }

  return { update, setOptions, fit, highlight, search, state, stop, zoomBy: k => svg.call(zoom.scaleBy, k) };
}
