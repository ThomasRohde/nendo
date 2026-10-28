import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// A first-party view's own words are English, and its index.html says so. Setting
// <html lang> to the person's locale would make a screen reader speak them in a Danish, Thai or
// Arabic voice. The locale formats dates, nothing else. The views run in a frame the browser
// lanes drive; here the rule is held where it is written, in each view's source. The packages
// are found rather than listed: the reference apps here, and nendo-apps holds the same test for
// its own (ADR-0040).

const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const extensions = new URL('../../../extensions/', import.meta.url);
const packages = readdirSync(extensions, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(new URL(`${entry.name}/index.html`, extensions)))
  .map(entry => entry.name).sort();
const views = packages.flatMap(name => readdirSync(new URL(`${name}/`, extensions))
  .filter(file => /\.m?js$/.test(file)).map(file => `extensions/${name}/${file}`));

test('the view packages are found', () => {
  for (const known of ['systems-lens', 'swarm'])
    assert.ok(packages.includes(known), `extensions/${known} was not found: ${JSON.stringify(packages)}`);
});

test('no first-party view marks its English text as the person\'s language', () => {
  for (const path of views) {
    const source = read(path);
    assert.doesNotMatch(source, /documentElement\.lang\s*=/, `${path} sets the page's language from the person's locale.`);
    assert.doesNotMatch(source, /documentElement\.lang\s*\|\|/, `${path} formats with the page's language rather than the locale.`);
  }
});

test('every view page still declares English', () => {
  for (const name of packages)
    assert.match(read(`extensions/${name}/index.html`), /<html lang="en">/, `${name}'s page does not declare English.`);
});

test('the authoring guide does not teach setting the page language from the locale', () => {
  assert.doesNotMatch(read('docs/custom-view-authoring.md'), /documentElement\.lang\s*=\s*context\.locale/,
    'The custom-view authoring guide teaches marking a view\'s text as the person\'s language.');
});
