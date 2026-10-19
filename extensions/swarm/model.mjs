export const TYPES = { Start: 'bpmn:StartEvent', Action: 'bpmn:Task', Decision: 'bpmn:ExclusiveGateway', End: 'bpmn:EndEvent' };
export const KIND = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
export const size = kind => kind === 'Action' ? { width: 120, height: 64 } : kind === 'Decision' ? { width: 50, height: 50 } : { width: 36, height: 36 };
export function route(from, to, index = 0) {
  const a = size(from.kind), b = size(to.kind);
  if (to.x <= from.x) {
    const lane = Math.max(from.y + a.height, to.y + b.height) + 50 + (index % 4) * 18;
    return [{ x: from.x + a.width / 2, y: from.y + a.height }, { x: from.x + a.width / 2, y: lane }, { x: to.x + b.width / 2, y: lane }, { x: to.x + b.width / 2, y: to.y + b.height }];
  }
  const start = { x: from.x + a.width, y: from.y + a.height / 2 }, end = { x: to.x, y: to.y + b.height / 2 };
  return start.y === end.y ? [start, end] : [start, { x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }, end];
}
const escape = value => String(value ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
export function diagramXML(model) {
  const tags = { Start: 'startEvent', Action: 'task', Decision: 'exclusiveGateway', End: 'endEvent' };
  const items = model.nodes.map(n => `<bpmn:${tags[n.kind]} id="${escape(n.id)}" name="${escape(n.name)}"/>`).join('');
  // A transition whose ends are not both drawn has nothing to join: fromRecords names it.
  const drawn = new Set(model.nodes.map(n => n.id));
  model = { ...model, links: model.links.filter(l => drawn.has(l.source) && drawn.has(l.target)) };
  const flows = model.links.map(l => `<bpmn:sequenceFlow id="${escape(l.id)}" sourceRef="${escape(l.source)}" targetRef="${escape(l.target)}" name="${l.branch === 'Next' ? '' : escape(l.branch)}"/>`).join('');
  const shapes = model.nodes.map(n => { const s = size(n.kind); return `<bpmndi:BPMNShape id="${escape(n.id)}_di" bpmnElement="${escape(n.id)}"><dc:Bounds x="${n.x}" y="${n.y}" width="${s.width}" height="${s.height}"/></bpmndi:BPMNShape>`; }).join('');
  const edges = model.links.map((l, index) => {
    const from = model.nodes.find(n => n.id === l.source), to = model.nodes.find(n => n.id === l.target); const a = size(from.kind), b = size(to.kind);
    const points = l.waypoints?.length >= 2 ? l.waypoints : route(from, to, index);
    return `<bpmndi:BPMNEdge id="${escape(l.id)}_di" bpmnElement="${escape(l.id)}">${points.map(p => `<di:waypoint x="${p.x}" y="${p.y}"/>`).join('')}</bpmndi:BPMNEdge>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Swarm" targetNamespace="https://nendo.example/swarm"><bpmn:process id="Behaviour" isExecutable="false">${items}${flows}</bpmn:process><bpmndi:BPMNDiagram id="Diagram"><bpmndi:BPMNPlane id="Plane" bpmnElement="Behaviour">${shapes}${edges}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram></bpmn:definitions>`;
}
export function preset(key = 'murmuration') {
  const id = suffix => `sw_${key}_${suffix}`;
  const node = (suffix, kind, name, x, y, extra = {}) => ({ id: id(suffix), kind, name, x, y, action: 'Wander', condition: 'Nearby', duration: 40, ...extra });
  const link = (suffix, source, target, branch = 'Next') => ({ id: id('link_' + suffix), source: id(source), target: id(target), branch, name: branch });
  const nodes = [node('start', 'Start', 'Born', 40, 157), node('wander', 'Action', 'Wander', 120, 143),
    node('danger', 'Decision', 'Startled?', 290, 150, { condition: 'Disturbed' }),
    node('flee', 'Action', 'Scatter', 410, 25, { action: 'Flee', duration: 70 }),
    node('nearby', 'Decision', 'Neighbours?', 410, 150),
    node('gather', 'Action', 'Gather', 530, 143, { action: 'Gather', duration: 50 }),
    node('align', 'Action', 'Fly together', 700, 143, { action: 'Align', duration: 90 })];
  const links = [link('born', 'start', 'wander'), link('sense', 'wander', 'danger'), link('startle', 'danger', 'flee', 'Yes'),
    link('calm', 'danger', 'nearby', 'No'), link('return', 'flee', 'wander'), link('found', 'nearby', 'gather', 'Yes'),
    link('alone', 'nearby', 'wander', 'No'), link('flock', 'gather', 'align'), link('again', 'align', 'wander')];
  const species = { id: `sw_species_${key}`, name: 'Murmuration', description: 'Gather into shifting flocks. Click the habitat to scatter them.', population: 240,
    speed: 2, perception: 85, cohesion: 1.6, alignment: 1.8, separation: 1.2, seed: 4207 };
  if (key === 'fireflies') {
    Object.assign(species, { name: 'Fireflies', description: 'Tiny gatherings alternate with stillness. Watch the lights settle and wake.', speed: 1.1, cohesion: 2.2, alignment: 0.2, seed: 7103 });
    Object.assign(nodes.find(n => n.id === id('align')), { name: 'Glow & rest', action: 'Rest', duration: 160 });
    nodes.splice(0, nodes.length, ...nodes.filter(n => ['start', 'wander', 'nearby', 'align'].some(suffix => n.id === id(suffix))));
    links.splice(0, links.length, link('born', 'start', 'wander'), link('sense', 'wander', 'nearby'), link('found', 'nearby', 'align', 'Yes'), link('alone', 'nearby', 'wander', 'No'), link('again', 'align', 'wander'));
  }
  if (key === 'skittish') {
    Object.assign(species, { name: 'Skittish', description: 'Independent wanderers with a quick startle response. Tap near a group.', speed: 2.8, perception: 60, cohesion: 0.15, alignment: 0.2, seed: 1709 });
    Object.assign(nodes.find(n => n.id === id('wander')), { duration: 8 });
    Object.assign(nodes.find(n => n.id === id('gather')), { name: 'Keep exploring', action: 'Wander', duration: 8 });
    Object.assign(nodes.find(n => n.id === id('align')), { name: 'Look around', action: 'Wander', duration: 8 });
    nodes.splice(0, nodes.length, ...nodes.filter(n => ['start', 'wander', 'danger', 'flee'].some(suffix => n.id === id(suffix))));
    links.splice(0, links.length, link('born', 'start', 'wander'), link('sense', 'wander', 'danger'), link('startle', 'danger', 'flee', 'Yes'), link('calm', 'danger', 'wander', 'No'), link('return', 'flee', 'wander'));
  }
  return { species, habitat: { id: 'sw_habitat_meadow', name: 'Open meadow', width: 1000, height: 620 }, nodes, links };
}
/**
 * One species as the view's model. Records edited in Studio can disagree with each other:
 * a transition whose From or To is a node of another species, or gone, is left out of the
 * diagram, and one whose Route points do not read is drawn along a route of its own. Each is
 * pushed to `problems` as { recordId, leftOut, message }, so the view can name it, and a save
 * leaves a left-out transition as it is rather than deleting it.
 */
export function fromRecords(records, speciesId, habitatId, problems = []) {
  const unpack = (r, prefix) => ({ id: r.recordId, ...Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k.slice(prefix.length + 1), v])) });
  const nodes = records.nodes.filter(r => r.values['sw.node.species'] === speciesId).map(r => unpack(r, 'sw.node'));
  const drawn = new Set(nodes.map(n => n.id));
  const links = [];
  for (const r of records.links.filter(r => r.values['sw.link.species'] === speciesId)) {
    const l = unpack(r, 'sw.link');
    if (!drawn.has(l.source) || !drawn.has(l.target)) {
      problems.push({ recordId: r.recordId, leftOut: true, message: `Transition ${r.recordId} joins a node that is not in this species, so it is left out of the diagram. Correct its From or To in Studio.` });
      continue;
    }
    let points = [];
    try { points = l.waypoints ? JSON.parse(l.waypoints) : []; } catch { points = null; }
    if (!Array.isArray(points) || !points.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))) {
      problems.push({ recordId: r.recordId, leftOut: false, message: `Transition ${r.recordId} has Route points that do not read, so it is drawn along a route of its own; saving the behaviour writes that route.` });
      points = [];
    }
    l.waypoints = points;
    links.push(l);
  }
  return { species: unpack(records.species.find(r => r.recordId === speciesId), 'sw.species'),
    habitat: unpack(records.habitats.find(r => r.recordId === habitatId) ?? records.habitats[0], 'sw.habitat'),
    nodes, links };
}
