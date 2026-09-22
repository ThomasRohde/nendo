import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// The proposal surface list is markup in one file and layout in another, and the two
// have drifted before: a class the markup emits with no rule behind it renders, so
// nothing fails and the line simply lands in the wrong place. This reads both sources
// and pairs them, because the only way to see it on screen is to look.
const markup = readFileSync(new URL('../src/view-agent.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles/08-panels.css', import.meta.url), 'utf8');

const surfaceList = markup.slice(markup.indexOf('class="proposal-surfaces"'));
const listItem = surfaceList.slice(0, surfaceList.indexOf('</ul>'));

test('every class the surface list emits has a rule behind it', () => {
  const emitted = [...listItem.matchAll(/class="([a-z][a-z0-9- ]*)"/g)]
    .flatMap((match) => match[1].split(' ').filter(Boolean));
  assert.ok(emitted.length > 0, 'the surface list emits no classes at all, so this guard reads the wrong markup');
  for (const name of new Set(emitted)) {
    assert.ok(styles.includes(`.${name}`), `class "${name}" is emitted by view-agent.ts and has no rule in 08-panels.css`);
  }
});

test('the size of a screen does not share a grid row with the record type it is about', () => {
  // Both spans match the list's `span:not(.surface-kind)` rule, which puts its match on
  // row 2. Without a row of its own the shape is drawn over the record type name.
  assert.match(styles, /\.proposal-surfaces li > span\.surface-shape \{[^}]*grid-row: 3;/);
  assert.ok(
    styles.indexOf('span.surface-shape') > styles.indexOf('span:not(.surface-kind)'),
    'the two rules have equal specificity, so the one that wins is the one written last',
  );
});
