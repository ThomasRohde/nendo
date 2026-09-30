import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { archiOnlineCommit, buildMirror, validateModel, VALIDATION_RULES } from '../../extensions/archi/canvas.js';
import { recordSets } from './archimate-records.mjs';

// W-117: the workbench's validator is archi-online's, run on the mirror of the file's records. The
// reference is what archi-online reports for its own models and for the cases of its validation
// tests (validation-parity.json, from make-validation-fixture.mjs). Each model goes into records
// as an import writes it and comes back through the mirror, so a difference is the file's or the
// mirror's, never the rules'.
const fixture = JSON.parse(readFileSync(new URL('./validation-parity.json', import.meta.url), 'utf8'));

/** An issue as the panel shows it and jumps from it: what, where, and the object to open. */
function shown(issue, recordIdOf = id => id) {
  const view = issue.location.view;
  return [issue.source, issue.severity, issue.rule, issue.message, recordIdOf(issue.location.modelTree.idPath.at(-1)),
    issue.location.modelTree.labelPath.join(' / '), view ? recordIdOf(view.viewId) : '', view?.objectId ? recordIdOf(view.objectId) : ''].join(' | ');
}

test('the reference was made from the archi-online commit the canvas was built from', () => {
  assert.equal(fixture.archiOnline, archiOnlineCommit);
  assert.equal(VALIDATION_RULES.length, 8);
});

for (const entry of fixture.entries) {
  test(`${entry.name}: the file reports what archi-online reports, issue by issue`, () => {
    const { records, recordIdOf } = recordSets(entry.model);
    const expected = entry.issues.map(issue => shown(issue, recordIdOf)).sort();
    const actual = validateModel(buildMirror(records)).map(issue => shown(issue)).sort();
    assert.deepEqual(actual, expected);
  });
}

test('the references cover every one of the eight rules, both flagged and clear', () => {
  const flagged = new Set(fixture.entries.flatMap(entry => entry.issues.map(issue => issue.rule)));
  for (const rule of VALIDATION_RULES) assert.ok(flagged.has(rule.id), `nothing flags ${rule.id}`);
  const scenarios = fixture.entries.filter(entry => entry.name.includes(': '));
  for (const rule of VALIDATION_RULES) {
    assert.ok(scenarios.some(entry => entry.name.startsWith(`${rule.id}:`) && !entry.issues.some(issue => issue.rule === rule.id)),
      `no case where ${rule.id} is clear`);
  }
});
