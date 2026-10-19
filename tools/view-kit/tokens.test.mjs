import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// A view stylesheet that says the value after each --nendo-* token is "that token as
// 02-tokens.css declares it" must hold exactly that value, in both themes. The fallbacks are
// what a page paints before api.js connects and when it runs outside Nendo, and three of them
// still carried the palette Nendo had before Mica while their comments said otherwise.
const repository = new URL('../../', import.meta.url);
const tokens = readFileSync(new URL('src/Nendo.Workbench/src/styles/02-tokens.css', repository), 'utf8');

function block(css, opening) {
  const match = opening.exec(css);
  if (match === null) return null;
  const start = match.index + match[0].length;
  return css.slice(start, css.indexOf('}', start));
}
const hex = value => {
  const text = value.trim().toLowerCase();
  return /^#[0-9a-f]{3}$/.test(text) ? '#' + [...text.slice(1)].map(digit => digit + digit).join('') : text;
};
function declared(body) {
  return new Map([...body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], hex(match[2])]));
}
const themes = {
  light: declared(block(tokens, /:root\s*\{/)),
  dark: declared(block(tokens, /:root\[data-theme="dark"\]\s*\{/)),
};

const extensions = new URL('extensions/', repository);
const sheets = readdirSync(extensions, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry =>
  readdirSync(new URL(`${entry.name}/`, extensions)).filter(name => name.endsWith('.css')).map(name => `extensions/${entry.name}/${name}`))
  .filter(sheet => existsSync(new URL(sheet, repository)) && readFileSync(new URL(sheet, repository), 'utf8').match(/02-tokens\.css\s+declares/) !== null)
  .sort();

test('the view stylesheets that claim the Workbench tokens are found', () => {
  for (const known of ['extensions/gantt/gantt.css', 'extensions/dependency-graph/graph.css', 'extensions/systems-lens/lens.css'])
    assert.ok(sheets.includes(known), `${known} no longer says its fallbacks are the tokens, or was not found: ` + JSON.stringify(sheets));
});

for (const sheet of sheets) {
  test(`${sheet}: every fallback is the token as 02-tokens.css declares it`, () => {
    const css = readFileSync(new URL(sheet, repository), 'utf8');
    const blocks = { light: block(css, /:root\s*\{/), dark: block(css, /:root\[data-theme=dark\]\s*\{/) };
    const wrong = [];
    let checked = 0;
    for (const [theme, body] of Object.entries(blocks)) {
      // Every claiming sheet has a light block; a sheet without a dark one takes Nendo's dark
      // tokens as they come and has no dark fallbacks to hold.
      assert.ok(body !== null || theme === 'dark', `${sheet} has no light :root block`);
      if (body === null) continue;
      for (const match of body.matchAll(/var\(--nendo-([a-z0-9-]+)\s*,\s*([^)]+)\)/g)) {
        const [, name, fallback] = match;
        // The palette is the claim: a shadow or other compound value is not compared.
        if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(fallback.trim())) continue;
        const token = themes[theme].get(name);
        checked += 1;
        if (token === undefined) wrong.push(`${theme} --nendo-${name}: 02-tokens.css declares no --${name}`);
        else if (hex(fallback) !== token) wrong.push(`${theme} --nendo-${name}: falls back to ${fallback.trim()}, but 02-tokens.css declares ${token}`);
      }
    }
    assert.ok(checked > 0, `${sheet} has no token fallbacks to check`);
    assert.deepEqual(wrong, [], `${sheet} says its fallbacks are the Workbench's tokens, and these are not:\n  ${wrong.join('\n  ')}`);
  });
}
