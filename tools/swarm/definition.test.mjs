import assert from 'node:assert/strict';
import test from 'node:test';
import { entities, definitionOperations, seedRecords, seedOperations, fixture } from './definition.mjs';
import { fromRecords, diagramXML, preset, route, size } from '../../extensions/swarm/model.mjs';
import { validate } from '../../extensions/swarm/simulation.mjs';
test('every seeded reference targets a real record of its declared type', () => {
  const records = seedRecords(), byId = new Map(records.map(r => [`${r.entityId}/${r.recordId}`, r]));
  for (const r of records) for (const [key, target] of entities.find(e => e.id === r.entityId).refs ?? [])
    assert.ok(byId.has(`${target}/${r.values[`${r.entityId}.${key}`]}`), `${r.recordId}.${key} points nowhere`);
  assert.equal(seedOperations().length, records.length);
  for (const o of seedOperations()) assert.ok(Object.values(o.payload.expectedTargetVersions).every(v => v === 1));
});
test('all presets reconstructed from typed records are executable, with no XML as authoritative state', () => {
  const r = fixture().records;
  for (const key of ['murmuration', 'fireflies', 'skittish']) {
    const m = fromRecords({ species: r['sw.species'], habitats: r['sw.habitat'], nodes: r['sw.node'], links: r['sw.link'] }, `sw_species_${key}`);
    assert.deepEqual(validate(m), []);
    assert.match(diagramXML(m), /isExecutable="false"/);
  }
  assert.equal(entities.length, 5);
  assert.ok(definitionOperations().some(o => o.payload.kind === 'extensionView' && o.payload.properties.opensFile));
});
test('diagram interchange escapes user text and preserves connection bendpoints', () => {
  const m = preset(); m.nodes[1].name = 'A < B & "C"'; m.links[0].waypoints = [{ x: 76, y: 180 }, { x: 90, y: 200 }, { x: 120, y: 180 }];
  const xml = diagramXML(m);
  assert.match(xml, /A &lt; B &amp; &quot;C&quot;/);
  assert.match(xml, /x="90" y="200"/);
});
test('preset return paths never pass through unrelated behaviour nodes', () => {
  for (const key of ['murmuration', 'fireflies', 'skittish']) {
    const m = preset(key);
    m.links.forEach((l, index) => {
      const points = route(m.nodes.find(n => n.id === l.source), m.nodes.find(n => n.id === l.target), index);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        for (const n of m.nodes.filter(n => n.id !== l.source && n.id !== l.target)) {
          const s = size(n.kind), left = n.x + 2, right = n.x + s.width - 2, top = n.y + 2, bottom = n.y + s.height - 2;
          const crosses = a.y === b.y ? a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right
            : a.x === b.x && a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
          assert.equal(crosses, false, `${key}: ${l.id} crosses ${n.name}, intercepting its pointer selection.`);
        }
      }
    });
  }
});
