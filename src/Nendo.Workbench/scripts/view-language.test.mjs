import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// R2LAT-10: a first-party view's own words are English, and its index.html says so. Setting
// <html lang> to the person's locale made a screen reader speak them in a Danish, Thai or
// Arabic voice. The locale formats dates, nothing else. The views run in a frame the browser
// lanes drive; here the rule is held where it is written, in each view's source.

const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

const views = [
  'extensions/garden/garden.js',
  'extensions/garden/tasks.mjs',
  'extensions/gantt/gantt.js',
  'extensions/dependency-graph/graph.js',
  'extensions/systems-lens/lens.js',
  'extensions/work-dependencies/view.js',
  'extensions/archi/view.js',
];

test('no first-party view marks its English text as the person\'s language', () => {
  for (const path of views) {
    const source = read(path);
    assert.doesNotMatch(source, /documentElement\.lang\s*=/, `${path} sets the page's language from the person's locale.`);
    assert.doesNotMatch(source, /documentElement\.lang\s*\|\|/, `${path} formats with the page's language rather than the locale.`);
  }
});

test('every view page still declares English', () => {
  for (const path of ['garden', 'gantt', 'dependency-graph', 'systems-lens', 'work-dependencies', 'archi'])
    assert.match(read(`extensions/${path}/index.html`), /<html lang="en">/, `${path}'s page does not declare English.`);
});

test('the Gantt formats its axis with the person\'s locale', () => {
  const gantt = read('extensions/gantt/gantt.js');
  assert.match(gantt, /locale = context\.locale \|\| 'en';/, 'The Gantt no longer takes the person\'s locale.');
  assert.match(gantt, /toLocaleDateString\(locale,/, 'The Gantt axis does not format with the locale.');
});

test('the authoring guide does not teach setting the page language from the locale', () => {
  assert.doesNotMatch(read('docs/custom-view-authoring.md'), /documentElement\.lang\s*=\s*context\.locale/,
    'The custom-view authoring guide teaches marking a view\'s text as the person\'s language.');
});
