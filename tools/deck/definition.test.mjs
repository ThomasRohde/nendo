import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES, STAGE_ORDER, PACKAGE_ID, PACKAGE_FOLDER, SKILL_URI, FAMILIES, ASK_SCOPES, ASK_STATUS, VARIANT_STATUS, ADDED_LAYOUTS, ADDED_CHARTS, EXAMPLE_ID, seedRecords, seedOperations, packageFiles, skillPackage, fixture, templateRecordId, exampleSlideId, tourOperations } from './definition.mjs';
import { EXAMPLE_SLIDES } from './example.mjs';
import { E, F, LAYOUT_IDS, CHARTS } from '../../extensions/deck/model.mjs';
import { TEMPLATES } from '../../extensions/deck/themes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = file => fs.readFile(path.join(repo, file), 'utf8');
// Every stage that declares fields: the record types, and the fields later stages add to them.
const schemaOps = () => [...STAGES.schema.mutations(), ...STAGES.design.mutations(), ...STAGES.present.mutations(), ...STAGES.layouts.mutations()].flatMap(m => m.operations);
const fieldOf = id => schemaOps().find(o => o.operationType === 'schema.addField' && o.payload.fieldId === id)?.payload;
/** A choice field's choices: those it is made with, then those later stages add. */
const choicesOf = id => [...fieldOf(id).options, ...schemaOps().filter(o => o.operationType === 'schema.addChoice' && o.payload.fieldId === id).map(o => o.payload.choiceId)];

test('each stage fits a change set, and each mutation a call', async () => {
  for (const name of STAGE_ORDER) {
    const mutations = await STAGES[name].mutations({ applicationId: 'app', read: { records: async id => id === E.deck ? [{ recordId: EXAMPLE_ID, recordVersion: 1, values: {} }] : [] } });
    const total = mutations.reduce((n, m) => n + m.operations.length, 0);
    assert.ok(mutations.every(m => m.operations.length <= 16), `${name}: a mutation over 16 operations`);
    assert.ok(total <= 128, `${name}: ${total} operations, over 128`);
    assert.ok(mutations.every(m => m.operations.every(o => !o.operationType.startsWith('data.')) || m.operations.every(o => o.operationType.startsWith('data.'))), `${name}: data and definition share a mutation`);
  }
});

test('every field the view and the skill name is declared, with the choices the model uses', async () => {
  const declared = new Set(schemaOps().filter(o => o.operationType === 'schema.addField').map(o => o.payload.fieldId));
  for (const [entity, fields] of Object.entries(F)) for (const id of Object.values(fields)) assert.ok(declared.has(id), `${entity}: ${id}`);
  assert.deepEqual([...choicesOf(F.slide.layout)].sort(), [...LAYOUT_IDS].sort());
  assert.deepEqual([...choicesOf(F.slide.chart)].sort(), [...CHARTS].sort());
  // A new file is made with the Layout and Chart choices of the schema stage, so the layouts stage adds each choice once.
  assert.ok(ADDED_LAYOUTS.every(id => !fieldOf(F.slide.layout).options.includes(id)) && ADDED_CHARTS.every(id => !fieldOf(F.slide.chart).options.includes(id)));
  assert.equal(new Set(choicesOf(F.slide.layout)).size, choicesOf(F.slide.layout).length);
  assert.deepEqual(fieldOf(F.template.family).options, FAMILIES);
  for (const id of [F.slide.image, F.slide.image2, F.slide.image3, F.slide.image4, F.brand.logo, F.brand.logoDark, F.brand.mark, F.template.titleImage, F.template.sectionImage, F.template.closingImage, F.template.contentImage]) assert.equal(fieldOf(id).presentation, 'media', id);
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

// The example deck's sixteen slides before Deck 1.6.0, by record: the layout each one keeps.
const FIRST_SIXTEEN = ['Title', 'Agenda', 'Section', 'Statement', 'Bullets', 'Two columns', 'Comparison', 'Image right', 'Full image', 'Quote', 'Big numbers', 'Timeline', 'Cards', 'Table', 'Chart', 'Closing'];

test('an example slide keeps its record whatever its place, so an older file can be brought up to it', () => {
  const ns = EXAMPLE_SLIDES.map(s => s.n);
  assert.equal(new Set(ns).size, ns.length, 'two example slides share a number');
  assert.deepEqual(FIRST_SIXTEEN.map((_, i) => EXAMPLE_SLIDES.find(s => s.n === i + 1)?.layout), FIRST_SIXTEEN);
  const slides = seedRecords().filter(r => r.entityId === E.slide);
  assert.deepEqual(slides.map(r => r.recordId), EXAMPLE_SLIDES.map(s => exampleSlideId(s.n)));
});

// What 1.6.0 changed in the example's first sixteen slides: the old words of each changed field.
const OLD_WORDS = { [exampleSlideId(1)]: { [F.slide.body]: 'Seventeen layouts, six templates, your brand' },
  [exampleSlideId(11)]: { [F.slide.body]: '- 17 | layouts | from title to closing\n- 6 | templates | each with its own decorations\n- 2 | exports | HTML and PowerPoint' },
  [exampleSlideId(15)]: { [F.slide.title]: 'This tour leans on text layouts', [F.slide.chart]: 'Bar', [F.slide.body2]: 'A chart is a table in the body. Pick Column, Bar, Line or Doughnut.',
    [F.slide.body]: '| Kind | Slides |\n| --- | --- |\n| Text | 6 |\n| Feature | 4 |\n| Data | 4 |\n| Picture | 2 |' } };

/** A file built before 1.6.0, as a person has used it: its own notes, a picture, two slides moved, a slide of their own. */
function olderFile() {
  const seeds = seedRecords().filter(r => r.entityId === E.slide && Number(r.recordId.slice(-2)) <= 16);
  const file = seeds.map(r => ({ recordId: r.recordId, recordVersion: 3, values: { ...r.values, ...OLD_WORDS[r.recordId],
    [F.slide.order]: Number(r.recordId.slice(-2)) * 10, [F.slide.notes]: `My own script for ${r.recordId}` } }));
  file.find(s => s.recordId === exampleSlideId(2)).values[F.slide.order] = 12;
  file.find(s => s.recordId === exampleSlideId(3)).values[F.slide.order] = 15;
  file.find(s => s.recordId === exampleSlideId(8)).values[F.slide.image] = 'media:abc';
  file.push({ recordId: 'dk.slide.mine', recordVersion: 1, values: { [F.slide.deck]: EXAMPLE_ID, [F.slide.order]: 55, [F.slide.layout]: 'Bullets', [F.slide.title]: 'Mine' } });
  return file;
}

/** Plays the operations onto a copy of the file, as Nendo would: each write at the version it expects. */
function play(file, ops) {
  const out = structuredClone(file);
  for (const o of ops) {
    if (o.operationType === 'data.createRecord') out.push({ recordId: o.payload.recordId, recordVersion: 1, values: { ...o.payload.values } });
    if (o.operationType === 'data.setField') {
      const s = out.find(x => x.recordId === o.payload.recordId);
      assert.equal(s.recordVersion, o.payload.expectedRecordVersion, `${o.payload.recordId} ${o.payload.fieldId}`);
      s.values[o.payload.fieldId] = o.payload.value;
      s.recordVersion++;
    }
  }
  return out;
}

// The example deck as a person has used it: its template and transition changed.
const DECK = { recordId: EXAMPLE_ID, recordVersion: 41, values: {} };

test('an empty file is built with every choice a seed uses declared before the seeds are written', async () => {
  const before = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf('seed'));
  const ops = [];
  for (const name of before) ops.push(...(await STAGES[name].mutations({ applicationId: 'app' })).flatMap(m => m.operations));
  const choices = new Map(ops.filter(o => o.operationType === 'schema.addField' && o.payload.presentation === 'singleChoice').map(o => [o.payload.fieldId, new Set(o.payload.options)]));
  for (const o of ops.filter(o => o.operationType === 'schema.addChoice')) choices.get(o.payload.fieldId).add(o.payload.choiceId);
  const fields = new Set(ops.filter(o => o.operationType === 'schema.addField').map(o => o.payload.fieldId));
  for (const r of seedRecords()) for (const [fieldId, value] of Object.entries(r.values)) {
    assert.ok(fields.has(fieldId), `${r.recordId}: ${fieldId} is written before a stage declares it`);
    if (choices.has(fieldId) && value != null) assert.ok(choices.get(fieldId).has(value), `${r.recordId}: ${fieldId} is ${value}, which no stage before the seeds declares`);
  }
});

test('the tour stage adds the new slides to an older example deck and keeps what the person changed', () => {
  const file = olderFile();
  const ops = tourOperations(file, DECK);
  // A new slide names the deck at the version it stands at, not the version it was seeded at.
  assert.ok(ops.filter(o => o.operationType === 'data.createRecord').every(o => o.payload.expectedTargetVersions[F.slide.deck] === 41));
  const after = play(file, ops);
  const seeds = seedRecords().filter(r => r.entityId === E.slide);
  // The four new slides are made, kept in new files, and stand between the slides around them.
  assert.deepEqual(ops.filter(o => o.operationType === 'data.createRecord').map(o => o.payload.recordId), [17, 18, 19, 20].map(exampleSlideId));
  assert.deepEqual(ops.filter(o => o.operationType === 'data.setKeptInNewFiles').map(o => o.payload.recordId), [17, 18, 19, 20].map(exampleSlideId));
  const shown = after.filter(s => s.recordId !== 'dk.slide.mine').sort((a, b) => a.values[F.slide.order] - b.values[F.slide.order]).map(s => s.recordId);
  assert.deepEqual(shown, seeds.map(r => r.recordId));
  assert.equal(new Set(after.map(s => s.values[F.slide.order])).size, after.length, 'two slides share an order');
  // The old words take the seed's; nothing else of the person's moves.
  for (const [recordId, fields] of Object.entries(OLD_WORDS)) {
    for (const fieldId of Object.keys(fields)) assert.equal(after.find(s => s.recordId === recordId).values[fieldId], seeds.find(r => r.recordId === recordId).values[fieldId], `${recordId} ${fieldId}`);
  }
  const written = new Set(ops.filter(o => o.operationType === 'data.setField').map(o => `${o.payload.recordId} ${o.payload.fieldId}`));
  assert.deepEqual([...written].sort(), Object.entries(OLD_WORDS).flatMap(([r, f]) => Object.keys(f).map(k => `${r} ${k}`)).sort());
  for (const s of file.filter(x => x.recordId !== 'dk.slide.mine')) assert.equal(after.find(x => x.recordId === s.recordId).values[F.slide.notes], s.values[F.slide.notes]);
  assert.deepEqual(after.find(s => s.recordId === 'dk.slide.mine'), file.find(s => s.recordId === 'dk.slide.mine'));
  assert.equal(after.find(s => s.recordId === exampleSlideId(2)).values[F.slide.order], 12);
  assert.equal(after.find(s => s.recordId === exampleSlideId(8)).values[F.slide.image], 'media:abc');
  // Played once, the stage has nothing more to do.
  assert.deepEqual(tourOperations(after, DECK), []);
});

test('the tour stage leaves words the person rewrote', () => {
  const file = olderFile();
  file.find(s => s.recordId === exampleSlideId(11)).values[F.slide.body] = '- 3 | teams | mine';
  const ops = tourOperations(file, DECK);
  assert.ok(!ops.some(o => o.payload.recordId === exampleSlideId(11)), 'a rewritten slide is written over');
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
