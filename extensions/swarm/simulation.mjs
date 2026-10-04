// Fixed-step simulation. No DOM, storage, wall clock or unseeded randomness.
export const LIMITS = Object.freeze({ population: 500, ticks: 18000, nodes: 32, links: 64 });
export const ACTIONS = ['Wander', 'Gather', 'Align', 'Flee', 'Rest'];
export const CONDITIONS = ['Nearby', 'Disturbed', 'Crowded'];
export function validate(model) {
  const errors = [];
  const { species: s, habitat: h, nodes, links } = model;
  if (!s || !h || !Array.isArray(nodes) || !Array.isArray(links)) return ['The experiment is missing its species, habitat or behaviour.'];
  const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  if (!Number.isInteger(s.population) || !bounded(s.population, 1, LIMITS.population)) errors.push('Population must be between 1 and 500.');
  for (const [key, min, max] of [['speed', 0.2, 5], ['perception', 20, 180], ['cohesion', 0, 3], ['alignment', 0, 3], ['separation', 0, 3]])
    if (!bounded(s[key], min, max)) errors.push(`${key} is outside its supported range (${min}–${max}).`);
  if (!Number.isInteger(s.seed) || !bounded(s.seed, 0, 2147483647)) errors.push('Seed must be a whole number between 0 and 2147483647.');
  if (!bounded(h.width, 400, 1600) || !bounded(h.height, 300, 1000)) errors.push('Habitat bounds must be 400–1600 by 300–1000.');
  if (nodes.length > LIMITS.nodes || links.length > LIMITS.links) errors.push('A behaviour supports at most 32 nodes and 64 connections.');
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length || new Set(links.map(l => l.id)).size !== links.length) errors.push('Every node and connection needs a distinct ID.');
  const starts = nodes.filter(n => n.kind === 'Start');
  if (starts.length !== 1) errors.push('Use exactly one start circle.');
  for (const n of nodes) {
    if (!['Start', 'Action', 'Decision', 'End'].includes(n.kind)) errors.push(`${n.name || n.id}: only start, action, decision and end nodes are supported.`);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) errors.push(`${n.name || n.id}: position is not a number.`);
    if (n.kind === 'Action' && (!ACTIONS.includes(n.action) || !Number.isInteger(n.duration) || n.duration < 1 || n.duration > 600))
      errors.push(`${n.name || n.id}: choose an action and a duration from 1 to 600 steps.`);
    if (n.kind === 'Decision' && !CONDITIONS.includes(n.condition)) errors.push(`${n.name || n.id}: choose Nearby, Disturbed or Crowded.`);
    const out = links.filter(l => l.source === n.id);
    if (n.kind === 'Decision') {
      if (out.length !== 2 || !out.some(l => l.branch === 'Yes') || !out.some(l => l.branch === 'No')) errors.push(`${n.name || n.id}: connect one Yes path and one No path.`);
    } else if (n.kind === 'End' ? out.length !== 0 : out.length !== 1) errors.push(`${n.name || n.id}: ${n.kind === 'End' ? 'an end has no outgoing path' : 'connect exactly one outgoing path'}.`);
  }
  for (const l of links) if (!ids.has(l.source) || !ids.has(l.target)) errors.push(`${l.name || l.id}: a connected node is missing.`);
  if (starts.length === 1) {
    const visited = new Set();
    const visit = id => { if (visited.has(id)) return; visited.add(id); links.filter(l => l.source === id).forEach(l => visit(l.target)); };
    visit(starts[0].id);
    for (const n of nodes) if (!visited.has(n.id)) errors.push(`${n.name || n.id}: connect this node to the start or remove it.`);
    // A decision-only cycle would never produce a movement step. Check both paths.
    const walk = (id, stack) => {
      const n = nodes.find(n => n.id === id);
      if (!n || n.kind === 'Action' || n.kind === 'End') return;
      if (stack.has(id)) { errors.push(`${n.name || n.id}: this loop needs an action between decisions.`); return; }
      const next = new Set(stack); next.add(id);
      links.filter(l => l.source === id).forEach(l => walk(l.target, next));
    };
    for (const n of nodes) walk(n.id, new Set());
  }
  return [...new Set(errors)];
}
function seeded(seed) {
  let value = seed >>> 0;
  return () => { value += 0x6D2B79F5; let t = value; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const wrapDelta = (d, size) => d > size / 2 ? d - size : d < -size / 2 ? d + size : d;
export class Simulation {
  constructor(model) {
    const errors = validate(model); if (errors.length) throw new Error(errors.join('\n'));
    this.model = structuredClone(model); this.tick = 0; this.events = []; this.activeDisturbances = [];
    this.random = seeded(model.species.seed); this.nodes = new Map(model.nodes.map(n => [n.id, n]));
    this.paths = new Map(model.nodes.map(n => [n.id, model.links.filter(l => l.source === n.id)]));
    const start = model.nodes.find(n => n.kind === 'Start').id;
    this.agents = Array.from({ length: model.species.population }, (_, id) => {
      const angle = this.random() * Math.PI * 2;
      return { id, x: this.random() * model.habitat.width, y: this.random() * model.habitat.height,
        vx: Math.cos(angle) * model.species.speed, vy: Math.sin(angle) * model.species.speed,
        node: start, age: Math.floor(this.random() * 30), action: 'Wander', neighbours: 0 };
    });
    this.metrics = { alignment: 0, neighbours: 0, moving: model.species.population, comparisons: 0, states: {} };
  }
  disturb(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const event = { tick: this.tick, x: Math.max(0, Math.min(this.model.habitat.width, x)), y: Math.max(0, Math.min(this.model.habitat.height, y)) };
    if (this.events.length >= 256) throw new Error('This run already has 256 disturbances. Reset to start another run.');
    this.events.push(event); this.activeDisturbances.push(event);
  }
  step() {
    if (this.tick >= LIMITS.ticks) return false;
    const { species: s, habitat: h } = this.model;
    const columns = Math.ceil(h.width / s.perception), rows = Math.ceil(h.height / s.perception);
    const cellWidth = h.width / columns, cellHeight = h.height / rows;
    const reachX = Math.ceil(s.perception / cellWidth), reachY = Math.ceil(s.perception / cellHeight);
    const buckets = new Map();
    const key = (x, y) => ((y + rows) % rows) * columns + ((x + columns) % columns);
    const old = this.agents.map(a => ({ ...a }));
    old.forEach(a => { const k = key(Math.floor(a.x / cellWidth), Math.floor(a.y / cellHeight)); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(a); });
    this.activeDisturbances = this.activeDisturbances.filter(e => this.tick - e.tick < 150);
    let headingX = 0, headingY = 0, neighbours = 0, moving = 0, comparisons = 0; const states = {};
    for (const a of this.agents) {
      const cx = Math.floor(a.x / cellWidth), cy = Math.floor(a.y / cellHeight);
      const keys = new Set(); for (let y = -reachY; y <= reachY; y++) for (let x = -reachX; x <= reachX; x++) keys.add(key(cx + x, cy + y));
      let count = 0, gatherX = 0, gatherY = 0, alignX = 0, alignY = 0, separateX = 0, separateY = 0;
      for (const k of keys) for (const b of buckets.get(k) ?? []) {
        if (a.id === b.id) continue; comparisons++;
        const dx = wrapDelta(b.x - a.x, h.width), dy = wrapDelta(b.y - a.y, h.height), d2 = dx * dx + dy * dy;
        if (d2 >= s.perception * s.perception) continue;
        count++; gatherX += dx; gatherY += dy; alignX += b.vx; alignY += b.vy;
        if (d2 < 24 * 24 && d2 > 0.001) { separateX -= dx / d2; separateY -= dy / d2; }
      }
      a.neighbours = count; neighbours += count;
      let danger = null;
      for (const e of this.activeDisturbances) {
        const dx = wrapDelta(a.x - e.x, h.width), dy = wrapDelta(a.y - e.y, h.height);
        if (dx * dx + dy * dy < 200 * 200) danger = { dx, dy };
      }
      let node = this.nodes.get(a.node);
      for (let hops = 0; node.kind !== 'Action' && node.kind !== 'End' && hops < LIMITS.nodes; hops++) {
        const condition = node.condition === 'Nearby' ? count > 0 : node.condition === 'Crowded' ? count >= 8 : danger !== null;
        const paths = this.paths.get(node.id), path = node.kind === 'Decision' ? paths.find(l => l.branch === (condition ? 'Yes' : 'No')) : paths[0];
        a.node = path.target; a.age = 0; node = this.nodes.get(a.node);
      }
      a.action = node.kind === 'End' ? 'Rest' : node.action;
      states[a.action] = (states[a.action] ?? 0) + 1;
      let dx = 0, dy = 0;
      if (a.action === 'Wander') { const angle = this.random() * Math.PI * 2; dx = Math.cos(angle) * 0.24; dy = Math.sin(angle) * 0.24; }
      if (a.action === 'Gather' && count) { dx += gatherX / count / s.perception * s.cohesion * 0.35; dy += gatherY / count / s.perception * s.cohesion * 0.35; }
      if (a.action === 'Align' && count) { dx += (alignX / count - a.vx) * s.alignment * 0.08; dy += (alignY / count - a.vy) * s.alignment * 0.08; }
      if (a.action === 'Flee' && danger) { const d = Math.hypot(danger.dx, danger.dy) || 1; dx += danger.dx / d * 0.8; dy += danger.dy / d * 0.8; }
      dx += separateX * s.separation * 2; dy += separateY * s.separation * 2;
      if (a.action === 'Rest') { a.vx *= 0.92; a.vy *= 0.92; }
      else {
        a.vx += dx; a.vy += dy; const speed = Math.hypot(a.vx, a.vy) || 1;
        a.vx = a.vx / speed * s.speed; a.vy = a.vy / speed * s.speed;
      }
      a.x = (a.x + a.vx + h.width) % h.width; a.y = (a.y + a.vy + h.height) % h.height;
      const speed = Math.hypot(a.vx, a.vy); if (speed > 0.05) { moving++; headingX += a.vx / speed; headingY += a.vy / speed; }
      if (node.kind === 'Action' && ++a.age >= node.duration) { a.node = this.paths.get(node.id)[0].target; a.age = 0; }
    }
    this.tick++;
    this.metrics = { alignment: moving ? Math.hypot(headingX, headingY) / moving : 0, neighbours: neighbours / s.population, moving, comparisons, states };
    return true;
  }
  snapshot(name = 'Experiment') {
    return { version: 1, name, model: structuredClone(this.model), ticks: this.tick, events: structuredClone(this.events) };
  }
  digest() { return this.agents.map(a => [a.x, a.y, a.vx, a.vy, a.node, a.age]); }
}
function prepareReplay(snapshot) {
  if (snapshot?.version !== 1 || !Number.isInteger(snapshot.ticks) || snapshot.ticks < 0 || snapshot.ticks > LIMITS.ticks || !Array.isArray(snapshot.events) || snapshot.events.length > 256)
    throw new Error('This experiment has an unsupported or incomplete snapshot.');
  let lastTick = -1;
  for (const e of snapshot.events) {
    if (!Number.isInteger(e.tick) || e.tick < lastTick || e.tick > snapshot.ticks || !Number.isFinite(e.x) || !Number.isFinite(e.y)) throw new Error('This experiment has an invalid disturbance.');
    lastTick = e.tick;
  }
  return new Simulation(snapshot.model);
}
export function replay(snapshot) {
  const sim = prepareReplay(snapshot); let next = 0;
  while (sim.tick <= snapshot.ticks) {
    while (next < snapshot.events.length && snapshot.events[next].tick === sim.tick) { const e = snapshot.events[next++]; sim.disturb(e.x, e.y); }
    if (sim.tick === snapshot.ticks) break;
    sim.step();
  }
  return sim;
}
export async function replayAsync(snapshot, onProgress = () => {}) {
  const sim = prepareReplay(snapshot); let next = 0;
  while (sim.tick <= snapshot.ticks) {
    while (next < snapshot.events.length && snapshot.events[next].tick === sim.tick) { const e = snapshot.events[next++]; sim.disturb(e.x, e.y); }
    if (sim.tick === snapshot.ticks) break;
    sim.step();
    if (sim.tick % 60 === 0) { onProgress(sim.tick, snapshot.ticks); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  return sim;
}
