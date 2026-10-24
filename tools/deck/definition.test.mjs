import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES, STAGE_ORDER, PACKAGE_ID, PACKAGE_FOLDER, SKILL_URI, FAMILIES, ASK_SCOPES, ASK_STATUS, VARIANT_STATUS, seedRecords, seedOperations, packageFiles, skillPackage, fixture, templateRecordId } from './definition.mjs';
import { E, F, LAYOUT_IDS, CHARTS } from '../../extensions/deck/model.mjs';
import { TEMPLATES } from '../../extensions/deck/themes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = file => fs.readFile(path.join(repo, file), 'utf8');
// Every stage that declares fields: the record types, and the fields later stages add to them.
const schemaOps = () => [...STAGES.schema.mutations(), ...STAGES.design.mutations(), ...STAGES.present.mutations()].flatMap(m => m.operations);
const fieldOf = id => schemaOps().find(o => o.operationType === 'schema.addField' && o.payload.fieldId === id)?.payload;

test('each stage fits a change set, and each mutation a call', async () => {
  for (const name of STAGE_ORDER) {
    const mutations = await STAGES[name].mutations({ applicationId: 'app' });
    const total = mutations.reduce((n, m) => n + m.operations.length, 0);
    assert.ok(mutations.every(m => m.operations.length <= 16), `${name}: a mutation over 16 operations`);
    assert.ok(total <= 128, `${name}: ${total} operations, over 128`);
    assert.ok(mutations.every(m => m.operations.every(o => !o.operationType.startsWith('data.')) || m.operations.every(o => o.operationType.startsWith('data.'))), `${name}: data and definition share a mutation`);
  }
});

test('every field the view and the skill name is declared, with the choices the model uses', async () => {
  const declared = new Set(schemaOps().filter(o => o.operationType === 'schema.addField').map(o => o.payload.fieldId));
  for (const [entity, fields] of Object.entries(F)) for (const id of Object.values(fields)) assert.ok(declared.has(id), `${entity}: ${id}`);
  assert.deepEqual(fieldOf(F.slide.layout).options, LAYOUT_IDS);
  assert.deepEqual(fieldOf(F.slide.chart).options, CHARTS);
  assert.deepEqual(fieldOf(F.template.family).options, FAMILIES);
  for (const id of [F.slide.image, F.brand.logo, F.brand.logoDark, F.brand.mark, F.template.titleImage, F.template.sectionImage, F.template.closingImage, F.template.contentImage]) assert.equal(fieldOf(id).presentation, 'media', id);
  const view = await read('extensions/deck/view.mjs');
  for (const word of [...view.matchAll(/'(Waiting|Working|Done|Failed|Cancelled|Proposed|Used|Dismissed|Whole deck|Selection|Mission)'/g)].map(m => m[1]))
    assert.ok([...ASK_STATUS, ...VARIANT_STATUS, ...ASK_SCOPES].includes(word), word);
  const skill = (await skillPackage()).skill;
  const named = new Set([...skill.matchAll(/`(dk\.[a-z]+(?:\.[a-zA-Z0-9]+)?)`/g)].map(m => m[1]));
  const known = new Set([...Object.values(E), ...declared]);
  // The skill shortens a run of one record's fields as `.title`; the full IDs it names must exist.
  for (const id of named) assert.ok(known.has(id), `the skill names ${id}, which the file does not declare`);
});

test('the view asks by the skill the file carries, and the skill knows each mission the view offers', async () => {
  const view = await read('extensions/deck/view.mjs');
  assert.ok(view.includes(`const SKILL = '${SKILL_URI}';`));
  const { manifest, skill } = await skillPackage();
  assert.equal(manifest.kind, 'skill');
  assert.match(skill, /^---\nname: deck\ndescription: .+\n---\n/);
  assert.equal(SKILL_URI, `skill://${manifest.packageId}/deck/SKILL.md`);
  const html = await read('extensions/deck/index.html');
  const missions = [...html.matchAll(/<option value="([^"]+)">/g)].map(m => m[1]);
  assert.equal(missions.length, 5);
  for (const mission of missions) assert.ok(skill.includes(`*${mission}*`), `the skill says nothing of the mission ${mission}`);
  for (const layout of LAYOUT_IDS) assert.ok(skill.includes(layout), `the skill does not name the layout ${layout}`);
});

test('the seeds: six templates, and an example deck whose slides all reference it', () => {
  const seeds = seedRecords();
  const templates = seeds.filter(r => r.entityId === E.template);
  assert.deepEqual(templates.map(r => r.recordId), TEMPLATES.map(t => templateRecordId(t.id)));
  assert.ok(templates.every(r => FAMILIES.includes(r.values[F.template.family])));
  const decks = seeds.filter(r => r.entityId === E.deck);
  assert.equal(decks.length, 1);
  assert.equal(decks[0].values[F.deck.template], templateRecordId('keynote'));
  const slides = seeds.filter(r => r.entityId === E.slide);
  assert.ok(slides.every(s => s.values[F.slide.deck] === decks[0].recordId && LAYOUT_IDS.includes(s.values[F.slide.layout])));
  assert.deepEqual(slides.map(s => s.values[F.slide.order]), slides.map((_, i) => (i + 1) * 10));
  const ops = seedOperations();
  assert.deepEqual(ops.find(o => o.payload.entityId === E.deck).payload.expectedTargetVersions, { [F.deck.template]: 1 });
  assert.ok(ops.filter(o => o.payload.entityId === E.slide).every(o => o.payload.expectedTargetVersions[F.slide.deck] === 1));
  // A person's own decks never travel into a new file: only seeds are kept.
  assert.ok(!schemaOps().some(o => o.operationType === 'schema.setKeptInNewFiles'));
});

test('the package carries every file the view loads, the kit unchanged, and no scratch file', async () => {
  const { manifest, files } = await packageFiles(PACKAGE_FOLDER);
  assert.equal(manifest.packageId, PACKAGE_ID);
  const names = files.map(f => f.path);
  const html = await read('extensions/deck/index.html');
  for (const ref of [...html.matchAll(/(?:href|src)="(?!\/_nendo\/)([^"]+)"/g)].map(m => m[1])) assert.ok(names.includes(ref), `index.html loads ${ref}`);
  for (const file of names.filter(n => n.endsWith('.mjs'))) {
    const source = await read(`extensions/deck/${file}`);
    for (const [, ref] of source.matchAll(/from '\.\/([^']+)'/g)) assert.ok(names.includes(ref), `${file} imports ${ref}`);
  }
  assert.ok(names.every(n => !/(^|\/)_/.test(n)), `a scratch file is in the package: ${names.filter(n => /(^|\/)_/.test(n))}`);
  assert.equal(await read('extensions/deck/kit/nendo-view-kit.js'), await read('tools/view-kit/nendo-view-kit.js'));
  const help = names.filter(n => n.startsWith('help/'));
  assert.ok(help.length >= 5);
  for (const page of help) assert.match(await read(`extensions/deck/${page}`), /^# \S/, page);
});

test('the fixture the lane serves is the schema the build writes', () => {
  const fx = fixture();
  assert.deepEqual(fx.schema.entities.map(e => e.entityId).sort(), Object.values(E).sort());
  assert.equal(fx.records[E.slide].length, seedRecords().filter(r => r.entityId === E.slide).length);
  assert.equal(fixture({ seeds: false }).records[E.deck].length, 0);
  assert.equal(fixture({ seeds: false }).records[E.template].length, 6);
});
