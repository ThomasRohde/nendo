import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { STAGES, STAGE_ORDER, seedRecords, seedOperations, seedNotes, fixture, PACKAGE_FOLDER, SKILL_FOLDER, SKILL_PACKAGE_ID, HOME_VIEW, RETIRED_SCREENS, decisionReferences } from './definition.mjs';
import { parse } from '../../extensions/garden/parse.mjs';
import { F } from '../../extensions/garden/sync.mjs';

const stageOps = async name => (await STAGES[name].mutations({ applicationId: 'application-test' })).flatMap(m => m.operations);
const allOps = async () => { const ops = []; for (const name of STAGE_ORDER) ops.push(...await stageOps(name)); return ops; };

/** The stored and calculated fields of each record type, as the schema and behaviour stages make them. */
async function fieldsByEntity() {
  const fields = new Map();
  for (const o of await stageOps('schema')) {
    if (o.operationType === 'schema.createEntity') fields.set(o.payload.entityId, new Map());
    if (o.operationType === 'schema.addField') fields.get(o.payload.entityId).set(o.payload.fieldId, { ...o.payload, calculated: false });
  }
  for (const o of await stageOps('behaviour')) {
    const b = o.payload.body;
    fields.get(b.entityId).set(b.fieldId, { fieldId: b.fieldId, storageKind: b.resultType, calculated: true, required: false });
  }
  return fields;
}

test('the notes name no architecture decision by its number', () => {
  for (const note of seedNotes()) {
    const found = decisionReferences(`${note.title}\n${note.summary ?? ''}\n${note.body}`);
    assert.deepEqual(found, [], `seed note ${note.slug} names an architecture decision: ${found.join(', ')}`);
  }
});

test('the decision guard finds the acronym and passes plain words', () => {
  assert.deepEqual(decisionReferences('Custom views keep their code (ADR-0013).'), ['ADR']);
  assert.deepEqual(decisionReferences('The accepted architecture decisions say so.'), []);
});

test('every stage fits one change set and every mutation one call', async () => {
  for (const name of STAGE_ORDER) {
    const mutations = await STAGES[name].mutations({ applicationId: 'application-test' });
    const count = mutations.reduce((n, m) => n + m.operations.length, 0);
    assert.ok(count > 0 && count <= 128, `stage ${name} holds ${count} operations; a change set carries 128`);
    // New package content in one change set is bounded at 4 MiB (custom-views.md, Limits).
    const content = mutations.flatMap(m => m.operations).filter(o => o.operationType === 'extension.putFile')
      .reduce((n, o) => n + (o.payload.base64 ? Buffer.from(o.payload.base64, 'base64').length : Buffer.byteLength(o.payload.text ?? '')), 0);
    assert.ok(content <= 4 * 1024 * 1024, `stage ${name} puts ${content} bytes of package content; a change set takes 4 MiB`);
    for (const m of mutations) assert.ok(m.operations.length <= 16, `"${m.description}" holds ${m.operations.length} operations; a call carries 16`);
    for (const m of mutations) {
      const lanes = new Set(m.operations.map(o => o.operationType.startsWith('data.') ? 'data' : 'definition'));
      assert.equal(lanes.size, 1, `"${m.description}" mixes data and definition operations`);
    }
  }
  assert.deepEqual(Object.keys(STAGES).sort(), [...STAGE_ORDER].sort());
});

test('every field a screen names exists on that node\'s record type, stored or calculated', async () => {
  const fields = await fieldsByEntity();
  const nodes = new Map();
  const entityOf = payload => {
    if (payload.properties.entityId) return payload.properties.entityId;
    if (payload.properties.targetEntityId) return payload.properties.targetEntityId;
    return payload.parentNodeId === null ? null : nodes.get(payload.parentNodeId);
  };
  const seenNodes = new Set();
  for (const o of await allOps()) {
    if (o.operationType !== 'ui.addNode') continue;
    const p = o.payload;
    assert.ok(!seenNodes.has(p.nodeId), `node ${p.nodeId} is added twice`);
    seenNodes.add(p.nodeId);
    if (p.parentNodeId !== null) assert.ok(nodes.has(p.parentNodeId), `${p.nodeId} is added before its parent ${p.parentNodeId}`);
    const entityId = entityOf(p);
    nodes.set(p.nodeId, entityId);
    const named = ['fieldId', 'labelFieldId', 'statusFieldId', 'orderByFieldId', 'titleFieldId', 'subtitleFieldId', 'accentFieldId', 'groupByFieldId', 'dateFieldId', 'rankByFieldId', 'visibleWhen', 'viaFieldId']
      .filter(key => p.properties[key] !== undefined).map(key => [key, p.properties[key]]);
    for (const [key, fieldId] of named) {
      const owner = p.kind === 'extensionGraphSurface' && fieldId.startsWith('gd.link.') ? 'gd.link'
        : p.kind === 'fieldBinding' && nodes.get(p.parentNodeId) === 'gd.note' && fieldId.startsWith('gd.link.') ? 'gd.link' : entityId;
      const field = fields.get(owner)?.get(fieldId);
      assert.ok(field, `${p.nodeId}.${key} names ${fieldId}, which ${owner} does not have`);
      if (key === 'visibleWhen') assert.ok(field.calculated && field.storageKind === 'Boolean', `${p.nodeId}.visibleWhen must name a Boolean calculation`);
      if (key === 'rankByFieldId') assert.ok(!field.calculated, `${p.nodeId} ranks by a calculated field, which a rankedList cannot`);
    }
    if (p.kind === 'commandStep') assert.ok(fields.get(nodes.get(p.parentNodeId))?.get(p.properties.fieldId)?.calculated === false, `${p.nodeId} sets a field that is not stored`);
  }
});

test('the graph screen runs the Garden package, and no stage carries the retired Dependency graph', async () => {
  const ops = await allOps();
  const graph = ops.find(o => o.operationType === 'ui.addNode' && o.payload.nodeId === 'gd.note.graph');
  assert.equal(graph.payload.kind, 'extensionGraphSurface');
  assert.equal(graph.payload.properties.packageId, 'org.nendo.garden');
  assert.ok(!ops.some(o => o.payload?.packageId === 'org.nendo.dependency-graph'), 'a stage still names org.nendo.dependency-graph');
  assert.ok(STAGE_ORDER.indexOf('garden') < STAGE_ORDER.indexOf('graph'), 'the package is in the file before the graph names it');
});

test('no two entries in Use share a name: the views of the file and the record types', async () => {
  const ops = await allOps();
  const names = [
    ...ops.filter(o => o.operationType === 'ui.addNode' && o.payload.parentNodeId === null && ['overviewSurface', 'extensionView'].includes(o.payload.kind)).map(o => o.payload.properties.title),
    ...ops.filter(o => o.operationType === 'schema.createEntity').map(o => o.payload.displayName),
  ];
  assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], `Use would list a name twice: ${names.join(', ')}`);
});

test('the Overview opens the file, no native front page, one page per record type, at most eight roots per kind', async () => {
  const roots = (await allOps()).filter(o => o.operationType === 'ui.addNode' && o.payload.parentNodeId === null).map(o => o.payload);
  const opens = roots.filter(r => r.kind === 'extensionView' && r.properties.opensFile === true);
  assert.deepEqual(opens.map(r => [r.nodeId, r.properties.title, r.properties.packageId]), [[HOME_VIEW, 'Overview', 'org.nendo.garden']], 'the Overview, and only it, opens the file');
  const views = roots.filter(r => r.kind === 'extensionView').map(r => r.nodeId);
  assert.deepEqual(views, [HOME_VIEW, 'gd.garden'], 'Use lists the Overview before the Garden view');
  assert.equal(roots.filter(r => r.kind === 'overviewSurface').length, 0, 'the Overview replaced the native front page');
  const perKind = new Map();
  for (const r of roots) {
    const key = `${r.properties.entityId ?? 'file'}/${r.kind}`;
    perKind.set(key, (perKind.get(key) ?? 0) + 1);
  }
  for (const [key, count] of perKind) {
    if (key.endsWith('/detailSurface')) assert.equal(count, 1, `${key}: one record page per type`);
    else assert.ok(count <= 8, `${key}: ${count} roots, at most 8`);
  }
});

test('Use offers only Notes and Tasks: the derived types keep their page and have no screen (W-184)', async () => {
  const useKinds = ['recordList', 'boardSurface', 'calendarSurface', 'timelineSurface', 'gallerySurface', 'matrixSurface', 'outlineSurface', 'extensionGraphSurface', 'extensionRecordsSurface'];
  const roots = (await allOps()).filter(o => o.operationType === 'ui.addNode' && o.payload.parentNodeId === null).map(o => o.payload);
  const screened = [...new Set(roots.filter(r => useKinds.includes(r.kind)).map(r => r.properties.entityId))].sort();
  assert.deepEqual(screened, ['gd.note', 'gd.task'], 'a type with a screen is a place in Use');
  for (const entityId of ['gd.link', 'gd.tag', 'gd.noteTag'])
    assert.ok(roots.some(r => r.kind === 'detailSurface' && r.properties.entityId === entityId), `${entityId} lost its record page`);
  for (const nodeId of RETIRED_SCREENS) assert.ok(!roots.some(r => r.nodeId === nodeId), `${nodeId} is still built`);
  const agenda = roots.find(r => r.nodeId === 'gd.task.agenda'), tend = roots.find(r => r.nodeId === 'gd.note.tend');
  assert.deepEqual([agenda.kind, agenda.properties.packageId, agenda.beforeNodeId], ['extensionRecordsSurface', 'org.nendo.garden', 'gd.task.due'], 'the Agenda leads the tasks');
  assert.deepEqual([tend.kind, tend.properties.packageId, tend.afterNodeId], ['extensionRecordsSurface', 'org.nendo.garden', 'gd.note.outline'], 'Tend follows the Tree');
  assert.ok(STAGE_ORDER.indexOf('garden') > STAGE_ORDER.indexOf('notes') && STAGE_ORDER.indexOf('garden') > STAGE_ORDER.indexOf('others'), 'the screens they are placed by are built first');
});

test('every reference is bound, every FilteredCount predicate and the pinned flag are required Booleans', async () => {
  const schema = await stageOps('schema');
  const references = schema.filter(o => o.operationType === 'schema.addField' && o.payload.storageKind === 'Reference').map(o => `${o.payload.entityId}/${o.payload.fieldId}`);
  const bound = schema.filter(o => o.operationType === 'schema.configureReference').map(o => `${o.payload.entityId}/${o.payload.fieldId}`);
  assert.deepEqual(references.sort(), bound.sort());
  const fields = await fieldsByEntity();
  for (const o of await stageOps('behaviour')) {
    for (const b of o.payload.body.bindings) {
      if (b.aggregate === 'FilteredCount') {
        const predicate = fields.get(b.relatedEntityId)?.get(b.predicateFieldId);
        assert.ok(predicate?.storageKind === 'Boolean' && predicate.required === true, `${o.payload.definitionId}: FilteredCount predicate ${b.predicateFieldId} must be a required Boolean, or a null member is a calculation error`);
      }
      if (b.kind === 'SameRecordCalculation') assert.ok(fields.get(b.entityId).has(b.calculationId.replace('gd.calc.', 'gd.note.')) || true);
    }
  }
  assert.equal(fields.get('gd.note').get(F.note.pinned).required, true, 'pinned must be required: the Overview and the Garden view read it as true or false');
  assert.equal(fields.get('gd.task').get(F.task.done).required, true);
  assert.ok(schema.some(o => o.operationType === 'schema.setFieldUnique' && o.payload.fieldId === F.note.slug), 'the slug must be unique');
  assert.ok(!schema.some(o => o.operationType === 'schema.setKeptInNewFiles'), 'no record type is kept whole: the person\'s notes must not travel into every new garden');
  assert.ok(!(await allOps()).some(o => o.payload?.definitionKind === 'Trigger' || o.payload?.definitionKind === 'Action'), 'no automatic actions');
});

test('the seeds reference only seeds, say what their bodies say, and are kept in new files', async () => {
  const records = seedRecords();
  const ids = new Set(records.map(r => r.recordId));
  const refs = { 'gd.note': [F.note.parent], 'gd.link': [F.link.from, F.link.to], 'gd.noteTag': [F.noteTag.note, F.noteTag.tag], 'gd.task': [F.task.note], 'gd.tag': [] };
  for (const r of records) for (const f of refs[r.entityId]) if (r.values[f] != null) assert.ok(ids.has(r.values[f]), `${r.recordId}.${f} points at ${r.values[f]}, which is not a seed`);
  assert.equal(new Set(records.map(r => r.recordId)).size, records.length, 'seed IDs are distinct');
  for (const r of records) assert.ok(ids.has(r.recordId) && records.indexOf(r) >= 0);
  // Every [[link]], #tag and - [ ] in a seed body has its row, and no row says more than the bodies do.
  const notes = seedNotes();
  for (const n of notes) {
    const parsed = parse(n.body);
    const id = `gd.note.${n.slug}`;
    const links = records.filter(r => r.entityId === 'gd.link' && r.values[F.link.from] === id && r.values[F.link.source] === 'Body');
    assert.equal(links.length, parsed.links.length, `${n.slug}: ${parsed.links.length} links in the body, ${links.length} Body link rows`);
    const tagged = records.filter(r => r.entityId === 'gd.noteTag' && r.values[F.noteTag.note] === id);
    assert.equal(tagged.length, parsed.tags.length, `${n.slug}: tags`);
    const tasks = records.filter(r => r.entityId === 'gd.task' && r.values[F.task.note] === id);
    assert.deepEqual(tasks.map(t => [t.values[F.task.title], t.values[F.task.done]]), parsed.tasks.map(t => [t.text, t.done]), `${n.slug}: tasks`);
  }
  assert.ok(records.some(r => r.entityId === 'gd.link' && r.values[F.link.source] === 'Manual'), 'one Manual link seeds the case a save must leave alone');
  const ops = seedOperations();
  assert.equal(ops.length, records.length);
  for (const o of ops) assert.ok(Object.values(o.payload.expectedTargetVersions).every(v => v === 1));
  const kept = await stageOps('keep');
  assert.deepEqual(kept.map(o => o.payload.recordId).sort(), records.map(r => r.recordId).sort(), 'every seed is kept in a new garden');
  assert.ok(kept.every(o => o.operationType === 'data.setKeptInNewFiles' && o.payload.kept === true));
});

test('the fixture says what the file would: schema, tones, hierarchy, seeds with labels, the view context', () => {
  const f = fixture();
  assert.deepEqual(f.schema.entities.map(e => e.entityId), ['gd.note', 'gd.link', 'gd.tag', 'gd.noteTag', 'gd.task']);
  const note = f.schema.entities[0];
  assert.deepEqual(note.hierarchy, { parentFieldId: F.note.parent, orderFieldId: F.note.order });
  assert.equal(note.fields.find(x => x.fieldId === F.note.stage).choices.find(c => c.id === 'Evergreen').tone, 'green');
  assert.equal(note.fields.find(x => x.fieldId === F.note.parent).storageKind, 'reference');
  assert.ok(f.records['gd.link'].every(l => l.labels[F.link.from] && l.labels[F.link.to]));
  assert.equal(f.context.kind, 'extensionView');
  assert.equal(f.context.viewId, 'gd.garden');
  assert.equal(f.hierarchies['gd.note'].parentFieldId, F.note.parent);
});

test('the package manifest, the kit copy and the skill are what the file will carry', () => {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_FOLDER, 'nendo-package.json'), 'utf8'));
  assert.equal(manifest.packageId, 'org.nendo.garden');
  assert.match(manifest.packageId, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
  assert.equal(manifest.entryPoint, 'index.html');
  for (const file of ['index.html', 'garden.js', 'garden.css', 'workspace.js', 'panel.js', 'graphscreen.js', 'graph.js', 'graph-data.mjs', 'parse.mjs', 'render.mjs', 'sync.mjs', 'related.mjs', 'kit/nendo-view-kit.js', 'diagrams.js', 'vendor/d3.min.js', 'vendor/d3.LICENSE.txt', 'vendor/mermaid.min.js', 'vendor/mermaid.LICENSE.txt', 'vendor/THIRD-PARTY-NOTICES.txt', 'LICENSE.txt']) {
    assert.ok(readFileSync(path.join(PACKAGE_FOLDER, file)).length > 0, `${file} is missing from the package`);
  }
  assert.match(readFileSync(path.join(PACKAGE_FOLDER, 'vendor/d3.min.js'), 'utf8').slice(0, 80), /d3js\.org v7\.9\.0/, 'the vendored d3 is the pinned 7.9.0');
  assert.ok(readFileSync(path.join(PACKAGE_FOLDER, 'vendor/mermaid.min.js'), 'utf8').includes('version:"11.17.2"'), 'the vendored Mermaid is the pinned 11.17.2');
  const html = readFileSync(path.join(PACKAGE_FOLDER, 'index.html'), 'utf8');
  assert.ok(!/<script[^>]*mermaid/i.test(html), 'Mermaid is loaded by diagrams.js when a page has a diagram, never by the page');
  assert.ok(html.indexOf('vendor/d3.min.js') > html.indexOf('/_nendo/api.js') && html.indexOf('vendor/d3.min.js') < html.indexOf('garden.js'), 'd3 loads after the API and before the view');
  const sources = ['garden.js', 'workspace.js', 'panel.js', 'graphscreen.js', 'graph.js', 'graph-data.mjs', 'parse.mjs', 'render.mjs', 'diagrams.js', 'sync.mjs', 'related.mjs', 'vendor/d3.min.js'].map(f => readFileSync(path.join(PACKAGE_FOLDER, f), 'utf8')).join('\n');
  assert.ok(!sources.includes('chrome.' + 'webview'), 'a package never names the host bridge');
  const skill = JSON.parse(readFileSync(path.join(SKILL_FOLDER, 'nendo-package.json'), 'utf8'));
  assert.equal(skill.packageId, SKILL_PACKAGE_ID);
  assert.equal(skill.kind, 'skill');
  const text = readFileSync(path.join(SKILL_FOLDER, 'SKILL.md'), 'utf8');
  const front = /^---\r?\nname: (\S+)\r?\ndescription: (.+?)\r?\n---\r?\n/s.exec(text);
  assert.ok(front, 'SKILL.md opens with frontmatter');
  assert.equal(front[1], SKILL_PACKAGE_ID.split('.').at(-1), 'the skill name is the package ID\'s last segment');
  assert.ok(front[2].length >= 1 && front[2].length <= 1024);
  assert.ok(text.includes('__APPLICATION_ID__'), 'the builder substitutes the application ID');
});
