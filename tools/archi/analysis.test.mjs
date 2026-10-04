import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as M from '../../extensions/archi/model.js';
import * as canvasModule from '../../extensions/archi/canvas.js';
import { recordSets } from './archimate-records.mjs';

// W-118: a concept's Analysis and the Visualiser's graph, measured against what archi-online gives
// for its own models (analysis-parity.json, from make-analysis-fixture.mjs). Each model goes into
// records as an import writes them; the Analysis is the workbench's own renderAnalysis, run as it
// ships, and what it lists is read from the markup it draws, in order.
const fixture = JSON.parse(readFileSync(new URL('./analysis-parity.json', import.meta.url), 'utf8'));
const validation = JSON.parse(readFileSync(new URL('./validation-parity.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../../extensions/archi/view.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `The production section ${start} could not be found.`);
  return source.slice(from, to);
}

/** The workbench's Analysis of each concept of a model: the records each list selects or opens, in order. */
function analyses(sets) {
  const state = { model: M.buildModel(sets), sets, readOnly: false };
  const context = vm.createContext({ M, state, canvasModule, canvasReady: Promise.resolve(),
    escape: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') });
  vm.runInContext(section('function listOf(', 'function renderDiagram(') + section('function renderAnalysis(', 'function renderCentre(') +
    '\nglobalThis.analyse = renderAnalysis;', context);
  const read = (html, list, attribute) => {
    const block = new RegExp(`<ul [^>]*data-analysis="${list}"[^>]*>(.*?)</ul>`, 's').exec(html)?.[1] ?? '';
    return [...block.matchAll(new RegExp(`${attribute}="([^"]*)"`, 'g'))].map(match => match[1]);
  };
  return concept => {
    const html = context.analyse(state.model.records.get(concept));
    const count = heading => Number(new RegExp(`${heading} \\((\\d+)\\)`).exec(html)?.[1]);
    return { relations: read(html, 'relations', 'data-select'), views: read(html, 'views', 'data-open-view'),
      counts: [count('Model relations'), count('Used in views')] };
  };
}

const modelOf = entry => entry.model ?? validation.entries.find(candidate => candidate.name === entry.name)?.model;

test('the reference was made from the archi-online commit the canvas was built from', () => {
  assert.equal(fixture.archiOnline, canvasModule.archiOnlineCommit);
  assert.ok(fixture.entries.some(entry => entry.name === 'Archisurance.archimate'));
});

for (const entry of fixture.entries) {
  test(`${entry.name}: every concept's model relations and views in use are archi-online's, in archi-online's order`, () => {
    const { records, recordIdOf } = recordSets(modelOf(entry));
    const analyse = analyses(records);
    const differences = [];
    for (const [concept, expected] of Object.entries(entry.concepts)) {
      const want = { relations: expected.relations.map(recordIdOf), views: expected.views.map(recordIdOf) };
      const got = analyse(recordIdOf(concept));
      want.counts = [want.relations.length, want.views.length];
      if (JSON.stringify(got) !== JSON.stringify(want)) differences.push(`${concept}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
    assert.deepEqual(differences.slice(0, 5), [], `${differences.length} of ${Object.keys(entry.concepts).length} concepts differ.`);
  });

  test(`${entry.name}: a view in the Analysis opens on the object archi-online opens it on`, () => {
    const { records, recordIdOf } = recordSets(modelOf(entry));
    const mirror = canvasModule.buildMirror(records);
    for (const [concept, expected] of Object.entries(entry.concepts)) {
      expected.views.forEach((viewId, index) => {
        const want = expected.objects[index] === null ? undefined : recordIdOf(expected.objects[index]);
        assert.equal(canvasModule.findInView(mirror, recordIdOf(viewId), recordIdOf(concept)), want, `${concept} on ${viewId}`);
      });
    }
  });
}

for (const entry of fixture.entries.filter(candidate => candidate.graphs)) {
  test(`${entry.name}: the Visualiser's graph is archi-online's for every focus and every control`, () => {
    const { records, recordIdOf } = recordSets(modelOf(entry));
    const mirror = canvasModule.buildMirror(records);
    for (const expected of entry.graphs) {
      const options = { ...expected.options, focusIds: expected.options.focusIds.map(recordIdOf) };
      const graph = canvasModule.analysisGraph(mirror, options);
      assert.deepEqual({ nodes: graph.nodes.map(node => node.id), edges: graph.edges.map(edge => edge.id), truncated: graph.truncated },
        { nodes: expected.nodes.map(recordIdOf), edges: expected.edges.map(recordIdOf), truncated: expected.truncated }, JSON.stringify(expected.options));
    }
  });
}

test('an element related to itself lists that relationship once, and a view it is on twice once', () => {
  const entry = fixture.entries.find(candidate => candidate.name === 'self-related');
  const { records, recordIdOf } = recordSets(entry.model);
  const self = Object.values(entry.model.elements).find(element => element.name === 'Self');
  const got = analyses(records)(recordIdOf(self.id));
  assert.equal(got.relations.length, 3);
  assert.equal(new Set(got.relations).size, 3, `A relationship is listed twice: ${got.relations.join(', ')}.`);
  assert.deepEqual(got.views.length, 2);
});
