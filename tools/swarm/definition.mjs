import { preset } from '../../extensions/swarm/model.mjs';
const op = (operationType, payload) => ({ operationType, payload });
const field = (entityId, key, name, kind = 'Text', required = false, presentation = 'singleLine', options = []) =>
  op('schema.addField', { entityId, fieldId: `${entityId}.${key}`, displayName: name, storageKind: kind, required, presentation: kind === 'Text' ? presentation : null, options });
export const entities = [
  { id: 'sw.species', name: 'Species', fields: [
    ['name', 'Name', 'Text', true], ['description', 'About', 'Text', false, 'longText'], ['population', 'Population', 'Integer', true],
    ['speed', 'Speed', 'Decimal', true], ['perception', 'Neighbour radius', 'Decimal', true], ['cohesion', 'Gather strength', 'Decimal', true],
    ['alignment', 'Align strength', 'Decimal', true], ['separation', 'Spacing', 'Decimal', true], ['seed', 'Seed', 'Integer', true],
  ] },
  { id: 'sw.node', name: 'Behaviour nodes', fields: [
    ['name', 'Name', 'Text', true], ['species', 'Species', 'Reference', true],
    ['kind', 'Kind', 'Text', true, 'singleChoice', ['Start', 'Action', 'Decision', 'End']],
    ['action', 'Action', 'Text', false, 'singleChoice', ['Wander', 'Gather', 'Align', 'Flee', 'Rest']],
    ['condition', 'Question', 'Text', false, 'singleChoice', ['Nearby', 'Disturbed', 'Crowded']],
    ['duration', 'Steps', 'Integer', false], ['x', 'X', 'Decimal', true], ['y', 'Y', 'Decimal', true],
  ], refs: [['species', 'sw.species']] },
  { id: 'sw.link', name: 'Transitions', fields: [
    ['name', 'Name', 'Text', true], ['species', 'Species', 'Reference', true], ['source', 'From', 'Reference', true], ['target', 'To', 'Reference', true],
    ['branch', 'Path', 'Text', true, 'singleChoice', ['Next', 'Yes', 'No']], ['waypoints', 'Route points', 'Text', false, 'longText'],
  ], refs: [['species', 'sw.species'], ['source', 'sw.node'], ['target', 'sw.node']] },
  { id: 'sw.habitat', name: 'Habitats', fields: [
    ['name', 'Name', 'Text', true], ['width', 'Width', 'Integer', true], ['height', 'Height', 'Integer', true],
  ] },
  { id: 'sw.experiment', name: 'Experiments', fields: [
    ['name', 'Name', 'Text', true], ['species', 'Species', 'Reference', true], ['habitat', 'Habitat', 'Reference', true],
    ['seed', 'Seed', 'Integer', true], ['steps', 'Steps', 'Integer', true], ['population', 'Population', 'Integer', true],
    ['snapshot', 'Captured behaviour and events', 'Text', true, 'longText'],
  ], refs: [['species', 'sw.species'], ['habitat', 'sw.habitat']] },
];
export function definitionOperations() {
  const ops = [op('application.setPurpose', { purpose: 'A living playground for creature behaviour. Species and their behaviour graphs, habitats and captured experiments are ordinary records. Edit a graph, watch the swarm, startle it, and save a seeded run to replay later. Simulation runs only while its custom view is open. Studio always reaches the underlying data.' }),
    op('application.setNewFileLabel', { label: 'swarm playground' })];
  for (const e of entities) {
    ops.push(op('schema.createEntity', { entityId: e.id, displayName: e.name }));
    ops.push(...e.fields.map(f => field(e.id, ...f)));
    for (const [key, target] of e.refs ?? []) ops.push(op('schema.configureReference', { entityId: e.id, fieldId: `${e.id}.${key}`, targetEntityId: target, labelFieldId: `${target}.name` }));
    if (e.id !== 'sw.experiment') ops.push(op('schema.setKeptInNewFiles', { entityId: e.id, kept: true }));
  }
  for (let position = 0; position < entities.length; position++) {
    const e = entities[position], nodeId = `${e.id}.list`;
    ops.push(op('ui.addNode', { surfaceId: 'swarm', nodeId, parentNodeId: null, kind: 'recordList', position,
      properties: { definitionVersion: 3, entityId: e.id, title: e.name } }));
    ops.push(op('ui.addNode', { surfaceId: 'swarm', nodeId: `${nodeId}.name`, parentNodeId: nodeId, kind: 'fieldBinding', position: 0, properties: { fieldId: `${e.id}.name` } }));
  }
  ops.push(op('ui.addNode', { surfaceId: 'swarm', nodeId: 'sw.screen.playground', parentNodeId: null, kind: 'extensionView', position: 5,
    properties: { definitionVersion: 3, title: 'Swarm', packageId: 'org.nendo.swarm', opensFile: true } }));
  return ops;
}
function values(entityId, record) {
  const e = entities.find(e => e.id === entityId);
  return Object.fromEntries(e.fields.map(([k]) => [`${entityId}.${k}`, k === 'waypoints' ? JSON.stringify(record[k] ?? []) : record[k] ?? null]));
}
export function seedRecords() {
  const models = ['murmuration', 'fireflies', 'skittish'].map(preset), records = [];
  records.push({ entityId: 'sw.habitat', recordId: models[0].habitat.id, values: values('sw.habitat', models[0].habitat) });
  for (const m of models) records.push({ entityId: 'sw.species', recordId: m.species.id, values: values('sw.species', m.species) });
  for (const m of models) for (const n of m.nodes) records.push({ entityId: 'sw.node', recordId: n.id, values: values('sw.node', { ...n, species: m.species.id }) });
  for (const m of models) for (const l of m.links) records.push({ entityId: 'sw.link', recordId: l.id, values: values('sw.link', { ...l, species: m.species.id }) });
  return records;
}
export function seedOperations() {
  return seedRecords().map(r => {
    const refs = entities.find(e => e.id === r.entityId).refs ?? [];
    return op('data.createRecord', { ...r, expectedTargetVersions: Object.fromEntries(refs.map(([key]) => [`${r.entityId}.${key}`, 1])) });
  });
}
export function fixture() {
  const schema = { entities: entities.map(e => ({ entityId: e.id, displayName: e.name, hierarchy: null, fields: e.fields.map(([k, name, kind = 'Text', required = false, presentation = 'singleLine', options = []]) => ({
    fieldId: `${e.id}.${k}`, displayName: name, storageKind: kind.toLowerCase(), required, presentation: kind === 'Text' ? presentation : null, calculated: false,
    choices: options.map(id => ({ id, displayName: id, retired: false, tone: null })), reference: (e.refs ?? []).some(([key]) => key === k) ? { targetEntityId: e.refs.find(([key]) => key === k)[1], labelFieldId: `${e.refs.find(([key]) => key === k)[1]}.name` } : null, scale: null,
  })) })) };
  const records = Object.fromEntries(entities.map(e => [e.id, []]));
  for (const r of seedRecords()) records[r.entityId].push({ ...r, version: 1, labels: {} });
  return { changeSequence: 1, schema, records, context: { viewId: 'sw.screen.playground', kind: 'extensionView', placement: 'screen', title: 'Swarm', entityId: null, recordId: null, bindings: { labelFieldId: null, statusFieldId: null, fields: [], filters: [] }, theme: 'light' } };
}
