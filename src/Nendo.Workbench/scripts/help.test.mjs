import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

const bundle = await build({ configFile: false, logLevel: 'error',
  build: { ssr: 'src/help.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { helpTopics, helpProviders, groupHelpTopics, helpSearchText, agentSurface, fileHelpTopic } = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
const context = { entities: [], applications: [], fileName: null };

// Mirrors of the closed surface pinned in tools/Test-Production.ps1. Adding a tool touches both lists on purpose.
const expectedTools = ['nendo.change_set.accept', 'nendo.change_set.add_operations', 'nendo.change_set.amend', 'nendo.change_set.begin', 'nendo.change_set.preview', 'nendo.change_set.reject', 'nendo.change_set.revalidate', 'nendo.change_set.validate', 'nendo.data.apply_writes', 'nendo.data.create_record', 'nendo.data.create_records', 'nendo.data.delete_record', 'nendo.data.execute_command', 'nendo.data.get_receipt', 'nendo.data.import_records', 'nendo.data.move_record', 'nendo.data.set_field', 'nendo.data.set_kept_in_new_files', 'nendo.data.undo_revision', 'nendo.data.update_record', 'nendo.health.verify_integrity', 'nendo.lease.acquire', 'nendo.lease.release', 'nendo.lease.renew', 'nendo.lease.status'];
const expectedResources = ['nendo://application/describe{?include}', 'nendo://application/entities', 'nendo://application/entity/{entityId}', 'nendo://application/entity/{entityId}/aggregate{?aggregate,fieldId,groupBy,rowBy,columnBy,dateFieldId,bucket,range,filter}', 'nendo://application/entity/{entityId}/export{?cursor,limit}', 'nendo://application/entity/{entityId}/records{?cursor,limit,recordId,sort,desc,filter,fields}', 'nendo://application/entity/{entityId}/schema', 'nendo://application/entity/{entityId}/tree{?root,depth,cursor,limit}', 'nendo://application/examples', 'nendo://application/extension/{packageId}/file{?path,offset,length}', 'nendo://application/extensions', 'nendo://application/health', 'nendo://application/history{?cursor,limit,newestFirst}', 'nendo://application/manifest', 'nendo://application/proposal/{proposalId}', 'nendo://application/proposals', 'nendo://application/revision/{revisionId}/operations{?cursor,limit}', 'nendo://application/search{?q,entity,field,cursor,limit}', 'nendo://application/surfaces', 'nendo://application/view-api', 'nendo://application/vocabulary', 'nendo://host/instances', 'skill://nendo-authoring/SKILL.md', 'skill://nendo-authoring/references/{file}', 'skill://{packageId}/{+path}'];

const topicText = id => JSON.stringify(helpTopics(context).find(topic => topic.id === id));

test('offline guides are available without an open file', () => {
  const topics = helpTopics(context);
  assert.ok(topics.find(topic => topic.id === 'mcp').setupRequest);
  assert.equal(topics.some(topic => topic.category === 'About this app'), false);
  for (const id of ['start', 'overview', 'one-file', 'data-model', 'screens', 'calculations', 'lanes', 'history', 'limits', 'csv', 'files', 'records', 'mcp', 'agent-access', 'agent-surface']) {
    assert.ok(topics.some(topic => topic.id === id), `${id} is a built-in guide`);
  }
});

test('MCP help hands the person the concrete registration commands and explains the lease behaviour', () => {
  const topic = helpTopics(context).find(topic => topic.id === 'mcp');
  assert.ok(topic.setupRequest.includes('claude mcp add --transport http nendo http://127.0.0.1:41763/mcp'));
  assert.ok(topic.setupRequest.includes('codex mcp add nendo --url http://127.0.0.1:41763/mcp'));
  // No credential exists any more; help must not send anyone looking for one.
  assert.doesNotMatch(JSON.stringify(topic), /bearer|discovery|session header|LOCALAPPDATA/i);
  assert.match(JSON.stringify(topic), /no credential/);
  assert.match(JSON.stringify(topic), /2026-07-28/);
  assert.match(JSON.stringify(topic), /Closing the agent alone does not release editing/);
  // The relaxed local defaults are the product promise; help must not drift back to the hardened wording.
  assert.match(JSON.stringify(topic), /Lease expiry is off unless/);
  assert.doesNotMatch(JSON.stringify(topic), /sixty seconds|short-lived/);
});

test('application reference follows new and renamed fields without losing stable topic identity', () => {
  const entity = { entityId: 'decision', displayName: 'Decision', fields: [{ fieldId: 'title', displayName: 'Title', required: true, options: [], presentation: null }] };
  const first = helpTopics({ ...context, entities: [entity] }).at(-1);
  entity.displayName = 'Decision log';
  entity.fields.push({ fieldId: 'status', displayName: '<Status & next>', required: false, presentation: 'choice', options: ['Open', 'Closed'] });
  const refreshed = helpTopics({ ...context, entities: [entity] }).at(-1);
  assert.equal(refreshed.id, first.id);
  assert.equal(refreshed.title, 'Decision log');
  assert.ok(refreshed.sections.find(section => section.heading === 'Fields').paragraphs.some(text => text.includes('<Status & next>') && text.includes('Open, Closed')));
});

test('application reference names reference targets and calculated fields, never an expression', () => {
  const owner = { entityId: 'owner', displayName: 'Owner', fields: [{ fieldId: 'name', displayName: 'Name', required: true, options: [], presentation: null }] };
  const item = { entityId: 'item', displayName: 'Item', fields: [{ fieldId: 'owner', displayName: 'Kept by', required: false, options: [], presentation: null, reference: { targetEntityId: 'owner', labelFieldId: 'name' } }],
    derivedFields: [{ fieldId: 'total', displayName: 'Total', calculationId: 'total', resultType: 'Decimal', resultNullable: true, expression: 'price * quantity' }] };
  const fields = helpTopics({ ...context, entities: [owner, item] }).find(topic => topic.id === 'entity:item').sections.find(section => section.heading === 'Fields').paragraphs;
  assert.ok(fields.some(text => text === 'Kept by: optional, reference to Owner.'));
  assert.ok(fields.some(text => text === 'Total: calculated, shown but never typed in.'));
  assert.ok(!fields.some(text => text.includes('price * quantity')));
});

test('host providers extend guides and reject ambiguous topic identities', () => {
  const extension = () => [{ id: 'extension.import', title: 'Import records', category: 'Data', summary: 'Import guide', sections: [] }];
  assert.ok(helpTopics(context, [...helpProviders, extension]).some(topic => topic.id === 'extension.import'));
  assert.throws(() => helpTopics(context, [...helpProviders, extension, extension]), /unique/);
});

test('the index puts the open file\'s app first, then the guides in a fixed order starting at Find your way around', () => {
  const groups = groupHelpTopics(helpTopics(context));
  assert.deepEqual(groups.map(group => group.category), ['Getting started', 'How Nendo works', 'Everyday work', 'Agents']);
  assert.equal(groups[0].topics[0].id, 'start');
  assert.ok(groups[1].topics.length >= 7, 'How Nendo works teaches the model in several topics');
  const entity = { entityId: 'note', displayName: 'Note', fields: [] };
  const page = { packageId: 'org.example.garden', packageTitle: 'Garden', path: 'help/01-start.md', markdown: '# Start here\n\nWelcome.' };
  const withApp = groupHelpTopics(helpTopics({ ...context, entities: [entity], pages: [page] }));
  assert.equal(withApp[0].category, 'About this app', 'The open file\'s app is first in the index.');
  assert.deepEqual(withApp[0].topics.map(topic => topic.id), ['page:org.example.garden/help/01-start.md', 'entity:note'],
    'The file\'s own pages come before the reference generated from its record types.');
  const extension = () => [{ id: 'x', title: 'X', category: 'Data', summary: '', sections: [] }];
  assert.equal(groupHelpTopics(helpTopics(context, [...helpProviders, extension])).at(-1).category, 'Data');
});

test('a page the file carries is a topic: its heading the title, its first paragraph the summary, the rest Markdown (ADR-0027)', () => {
  const topic = fileHelpTopic({ packageId: 'org.example.garden', packageTitle: 'Garden', path: 'help/02-links.md',
    markdown: '\uFEFF\n# How **links** work\r\n\r\nWrite `[[a note]]` and *save*: [the link](https://x.example) becomes a record.\nSecond line.\n\n## Backlinks\n\n- one\n' });
  assert.equal(topic.title, 'How links work', 'A title is plain text: its inline Markdown is taken off.');
  assert.equal(topic.category, 'About this app');
  assert.equal(topic.source, 'Garden');
  assert.equal(topic.summary, 'Write [[a note]] and save: the link becomes a record. Second line.');
  assert.equal(topic.markdown, '## Backlinks\n\n- one');
  assert.ok(helpSearchText(topic).includes('backlinks'), 'Search reaches the page\'s Markdown.');
  const untitled = fileHelpTopic({ packageId: 'p.q', packageTitle: 'Q', path: 'help/03-keyboard_keys.md', markdown: '- a list first\n' });
  assert.equal(untitled.title, 'Keyboard keys', 'Without a heading the file name, less its number, is the title.');
  assert.equal(untitled.summary, '', 'A list is not a summary.');
  assert.equal(untitled.markdown, '- a list first');
});

test('the agent surface article names every resource and tool the host declares, and no other tool', () => {
  const text = topicText('agent-surface');
  for (const name of [...expectedTools, ...expectedResources]) assert.ok(text.includes(name), name);
  assert.deepEqual([...agentSurface.editDataTools, ...agentSurface.shapeAppTools, ...agentSurface.unattendedTools].map(tool => tool.name).sort(), expectedTools);
  assert.deepEqual([...agentSurface.resources].map(resource => resource.name).sort(), expectedResources);
  assert.deepEqual([...new Set(text.match(/nendo\.(?:lease|data|health|change_set)\.[a-z_]+/g))].sort(), expectedTools);
  assert.match(text, /NENDO_STALE_CURSOR/);
  assert.match(text, /NENDO_INVALID_CURSOR/);
  assert.match(text, /Below Unattended, no tool accepts a proposal: acceptance stays with you, in Nendo\./);
});

test('what the person is told matches the words on screen', () => {
  for (const label of ['Off', 'Inspect', 'Edit data', 'Shape app', 'Unattended', 'Local agent', 'Revoke edit access', 'Editing owner', 'Pending changes']) assert.ok(topicText('agent-access').includes(label), label);
  for (const label of ['Not set', 'Calculating…', 'Cannot calculate', 'Approve automatic actions', 'Withdraw approval', 'Approval needed']) assert.ok(topicText('calculations').includes(label), label);
  for (const label of ['Reversible', 'Compensatable with retained state', 'Not compensatable', 'Save unconfirmed', 'Acceptance unconfirmed']) assert.ok(topicText('history').includes(label), label);
  for (const label of ['Read-only', 'Recovery required', 'Approval needed', 'Check or retry save']) assert.ok(topicText('one-file').includes(label), label);
  for (const label of ['What changes', 'What this builds', 'Accept changes', 'Preview changes']) assert.ok(topicText('lanes').includes(label), label);
  assert.match(topicText('limits'), /Windows/);
  assert.match(topicText('limits'), /no universal undo/i);
});

test('search reaches article bodies, not only titles', () => {
  const topic = helpTopics(context).find(item => item.id === 'agent-surface');
  assert.ok(helpSearchText(topic).includes('nendo_stale_cursor'));
  assert.ok(!`${topic.title} ${topic.summary}`.toLowerCase().includes('nendo_stale_cursor'));
  const history = helpTopics(context).find(item => item.id === 'history');
  assert.ok(helpSearchText(history).includes('compensatable with retained state'));
});

test('built-in guides stay inside the vocabulary gates and link only to topics that exist', () => {
  const topics = helpTopics(context);
  for (const topic of topics) {
    const text = JSON.stringify(topic);
    assert.doesNotMatch(text, /[<>]/, `${topic.id} carries markup`);
    // tools/Test-ApplicationNeutrality.ps1 fails the build on these; fail here first, with the topic named.
    assert.doesNotMatch(text, /\b[A-Za-z0-9_]*(?:idea|decision)[A-Za-z0-9_]*\b/i, `${topic.id} names an application`);
    if (topic.id !== 'mcp') assert.doesNotMatch(text, /\b(?:codex|claude)\b/i, `${topic.id} names a client`);
    assert.doesNotMatch(text, /bearer|discovery|session header|LOCALAPPDATA|sixty seconds|short-lived/i, `${topic.id} drifted to hardened wording`);
    assert.ok(topic.sections.length > 0, `${topic.id} has no sections`);
    for (const section of topic.sections) {
      assert.ok((section.paragraphs?.length ?? 0) + (section.steps?.length ?? 0) + (section.terms?.length ?? 0) > 0, `${topic.id} / ${section.heading} is empty`);
      for (const term of section.terms ?? []) assert.ok(term.term.length > 0 && term.meaning.length > 0, `${topic.id} / ${section.heading} has an empty term`);
    }
    for (const id of topic.related ?? []) {
      assert.notEqual(id, topic.id, `${topic.id} links to itself`);
      assert.ok(topics.some(candidate => candidate.id === id), `${topic.id} links to missing ${id}`);
    }
  }
});
