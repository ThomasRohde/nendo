import assert from 'node:assert/strict';
import test from 'node:test';
import { STAGES, STAGE_ORDER } from '../archi-definition.mjs';

// Nendo's Use list draws a record's first field as its heading and the next two beside it, and
// nothing after (listMarkup in src/Nendo.Workbench/src/surface-markup.ts). A column bound fourth is
// never seen: the owner found the On views count missing that way (W-117, 2026-09-30). The screens
// are replayed here in stage order, moves included, to name what each list draws.
const DRAWN = 3;

async function screens() {
  // As the Engine keeps them: each node holds the position it was given, a move sets it and
  // renumbers nothing, and siblings read in order of position, then node ID
  // (SqliteNendoStore.Read.cs). A move to a taken position therefore ties, and the ID decides.
  const nodes = new Map(), fields = new Map();
  for (const name of STAGE_ORDER) {
    for (const mutation of await STAGES[name].mutations()) {
      for (const { operationType, payload } of mutation.operations) {
        if (operationType === 'ui.addNode') {
          nodes.set(payload.nodeId, { parent: payload.parentNodeId ?? '', position: payload.position, kind: payload.kind });
          if (payload.kind === 'fieldBinding') fields.set(payload.nodeId, payload.properties.fieldId);
        } else if (operationType === 'ui.moveNode') {
          Object.assign(nodes.get(payload.nodeId), { parent: payload.parentNodeId ?? '', position: payload.position });
        } else if (operationType === 'ui.removeNode') nodes.delete(payload.nodeId);
      }
    }
  }
  const children = new Map();
  for (const [nodeId, node] of [...nodes].sort(([a, x], [b, y]) => x.position - y.position || (a < b ? -1 : a > b ? 1 : 0))) {
    if (!children.has(node.parent)) children.set(node.parent, []);
    children.get(node.parent).push(nodeId);
  }
  const kinds = new Map([...nodes].map(([id, node]) => [id, node.kind]));
  const lists = {};
  for (const [nodeId, kind] of kinds) {
    if (kind !== 'recordList') continue;
    const bound = (children.get(nodeId) ?? []).filter(id => kinds.get(id) === 'fieldBinding').map(id => fields.get(id));
    lists[nodeId] = { drawn: bound.slice(0, DRAWN), hidden: bound.slice(DRAWN) };
  }
  return { lists, children, fields };
}

test('the Elements and Views lists draw their diagram-object counts', async () => {
  const { lists } = await screens();
  assert.ok(lists['ar.screen.elements'].drawn.includes('ar.concept.occurrences'), `Elements draws ${lists['ar.screen.elements'].drawn.join(', ')}`);
  assert.ok(lists['ar.screen.views'].drawn.includes('ar.view.objects'), `Views draws ${lists['ar.screen.views'].drawn.join(', ')}`);
});

test('a concept page shows how many diagram objects show the concept', async () => {
  const { children, fields } = await screens();
  assert.ok((children.get('ar.page.concept.details') ?? []).some(id => fields.get(id) === 'ar.concept.occurrences'));
});

test('what each list binds but does not draw is known', async () => {
  const { lists } = await screens();
  const hidden = Object.fromEntries(Object.entries(lists).filter(([, list]) => list.hidden.length > 0).map(([id, list]) => [id, list.hidden]));
  assert.deepEqual(hidden, {
    'ar.screen.elements': ['ar.concept.folder'],
    'ar.screen.relationships': ['ar.concept.name', 'ar.concept.occurrences'],
    'ar.screen.views': ['ar.view.folder'],
    'ar.screen.items': ['ar.item.x', 'ar.item.y'],
    'ar.screen.properties': ['ar.property.view'],
  });
});
