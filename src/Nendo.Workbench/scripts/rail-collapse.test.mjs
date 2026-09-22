import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// The rail is static markup in index.html, which no SSR test can reach: the other files
// here build a module and call its markup function, and the shell has none. So this pairs
// the three sources the collapsed rail is spread across -- the button, the rule that
// narrows the grid, and the import order that decides whether the rule ever applies.
const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const collapse = readFileSync(new URL('../src/styles/15-rail-collapse.css', import.meta.url), 'utf8');
const sheet = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/shell.ts', import.meta.url), 'utf8');

test('the rail carries a toggle that says what it controls and what state it is in', () => {
  const rail = shell.slice(shell.indexOf('<aside'), shell.indexOf('</aside>'));
  assert.match(rail, /id="app-rail"/, 'the toggle names a rail that has no id to be named by');
  assert.match(rail, /id="rail-toggle"/, 'index.html has no rail toggle');
  const toggle = rail.slice(rail.indexOf('id="rail-toggle"'));
  assert.match(toggle.slice(0, toggle.indexOf('>')), /aria-expanded="true"/);
  assert.match(toggle.slice(0, toggle.indexOf('>')), /aria-controls="app-rail"/);
});

test('the collapsed rail is narrow, and its labels are hidden rather than removed', () => {
  assert.match(collapse, /:root\[data-rail="collapsed"\] \.app-shell \{[^}]*grid-template-columns: 56px/);
  // Removing the label from the DOM would take the route's name away from a screen
  // reader; clipping it keeps the rail navigable while it is only icons wide.
  assert.match(collapse, /:root\[data-rail="collapsed"\] \.rail \.nav-item > span:not\(\.nav-symbol\) \{[^}]*clip-path: inset\(50%\)/);
});

test('the collapsed rules load after the two slices that already restyle the rail', () => {
  // 10 turns the rail into a top bar and 12 gives it a compact layout, both under their
  // own media queries and both at the same specificity as these rules. Written earlier,
  // this slice loses and the toggle looks broken rather than absent.
  const collapsed = sheet.indexOf('15-rail-collapse');
  assert.ok(collapsed > 0, 'styles.css does not import the collapsed-rail slice at all');
  assert.ok(collapsed > sheet.indexOf('10-forms'), 'the collapsed rail is imported before 10-forms.css and loses to it');
  assert.ok(collapsed > sheet.indexOf('12-agent-activity'), 'the collapsed rail is imported before 12-agent-activity.css and loses to it');
});

test('the rail state is kept for the device and never asked of the host', () => {
  assert.match(script, /const railStorageKey = 'nendo\.rail';/);
  // Storage that refuses to answer must leave the rail open, not throw on the way to
  // the first paint.
  const read = script.slice(script.indexOf('export function readRailCollapsed'));
  assert.match(read.slice(0, read.indexOf('\n}')), /catch \{\s*return false;/);
  const apply = script.slice(script.indexOf('export function applyRail'));
  const body = apply.slice(0, apply.indexOf('\n}'));
  assert.ok(!body.includes('client.request'), 'the rail state does not belong on the host bridge');
});
