import assert from 'node:assert/strict';
import test from 'node:test';
import { Simulation, replay, replayAsync, validate, LIMITS } from '../../extensions/swarm/simulation.mjs';
import { preset } from '../../extensions/swarm/model.mjs';
test('a captured experiment replays exactly, including disturbances and an event on its final step', () => {
  const sim = new Simulation(preset('skittish'));
  sim.disturb(500, 300);
  for (let i = 0; i < 240; i++) { if (i === 40) sim.disturb(120, 180); sim.step(); }
  sim.disturb(900, 600);
  const snapshot = JSON.parse(JSON.stringify(sim.snapshot()));
  assert.deepEqual(replay(snapshot).digest(), sim.digest());
  assert.deepEqual(replay(snapshot).events, sim.events);
  const changed = preset('skittish'); changed.species.speed = 4;
  assert.notDeepEqual(new Simulation(changed).digest(), sim.digest());
  assert.deepEqual(snapshot.model, sim.model);
});
test('the behaviour graph controls trajectories, rather than merely decorating the habitat', () => {
  const normal = preset(); const altered = structuredClone(normal);
  altered.nodes.filter(n => n.action === 'Align' || n.action === 'Gather').forEach(n => { n.action = 'Wander'; });
  const a = new Simulation(normal), b = new Simulation(altered);
  for (let i = 0; i < 900; i++) { a.step(); b.step(); }
  assert.notDeepEqual(a.digest(), b.digest());
  assert.ok(a.metrics.alignment > b.metrics.alignment + 0.25, `Graph change did not change heading agreement: ${a.metrics.alignment} / ${b.metrics.alignment}`);
});
test('long replay yields to the UI and still reconstructs the exact captured state', async () => {
  const sim = new Simulation(preset('skittish')); sim.disturb(200, 150); for (let i = 0; i < 180; i++) sim.step();
  let yielded = false, progress = 0;
  setTimeout(() => { yielded = true; }, 0);
  const restored = await replayAsync(sim.snapshot(), () => { progress++; });
  assert.equal(yielded, true); assert.equal(progress, 3); assert.deepEqual(restored.digest(), sim.digest());
});
test('the presets produce distinct flocking, resting and independent movement', () => {
  const simulations = ['murmuration', 'fireflies', 'skittish'].map(key => new Simulation(preset(key)));
  for (let i = 0; i < 600; i++) simulations.forEach(s => s.step());
  assert.ok(simulations[0].metrics.alignment > .5);
  assert.ok(simulations[1].metrics.states.Rest > 100);
  assert.ok(simulations[2].metrics.alignment < .3);
});
test('wrapped neighbours are found across a short last spatial bucket', () => {
  const m = preset(); m.species.population = 2; m.species.perception = 85;
  const sim = new Simulation(m);
  Object.assign(sim.agents[0], { x: 1, y: 100 }); Object.assign(sim.agents[1], { x: 920, y: 100 });
  sim.step();
  assert.equal(sim.agents[0].neighbours, 1, 'Wrapped neighbour at x=920 was missed from x=1 (radius 85).');
  assert.equal(sim.agents[1].neighbours, 1);
});
test('500 creatures stay finite, bounded and deterministic with spatially bounded reads', () => {
  const m = preset(); m.species.population = 500;
  const sim = new Simulation(m); for (let i = 0; i < 120; i++) sim.step();
  assert.equal(sim.agents.length, 500);
  assert.ok(sim.metrics.comparisons < 500 * 499, 'Neighbour search visited the whole population for every creature.');
  assert.ok(sim.agents.every(a => Number.isFinite(a.vx) && a.x >= 0 && a.x < m.habitat.width && a.y >= 0 && a.y < m.habitat.height));
  assert.deepEqual(replay(sim.snapshot()).digest(), sim.digest());
  sim.tick = LIMITS.ticks; assert.equal(sim.step(), false);
});
test('invalid graphs and snapshots fail with named, bounded diagnostics', () => {
  const m = preset(); m.links.find(l => l.branch === 'Yes').branch = 'No';
  assert.match(validate(m).join('\n'), /Startled\?.*Yes path/);
  const broken = preset(); broken.links[0].target = 'missing'; assert.match(validate(broken).join('\n'), /connected node is missing/);
  assert.throws(() => replay({ version: 1, model: preset(), ticks: LIMITS.ticks + 1, events: [] }), /unsupported/);
  assert.throws(() => replay({ version: 1, model: preset(), ticks: 1, events: [{ tick: 2, x: 10, y: 10 }] }), /invalid disturbance/);
});
