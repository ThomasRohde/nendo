import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// WXS-08: a view handed back Ctrl+W, Alt+ArrowLeft or a menu while the person typed in a Nendo
// field, and the Workbench ran it as if the key had been pressed in the view. The frame element
// is the Workbench's focused element whenever a key is really pressed inside the view.
const { viewKeyMayRun, viewMenuMayShow, menuAfterCommandMs } = await bundleOf('src/view-input.ts');

const frame = { tagName: 'IFRAME' };
const field = { tagName: 'INPUT' };

test('a key a view hands back runs only while its frame has focus', () => {
  assert.equal(viewKeyMayRun(frame, frame), true, 'a key pressed inside the view was dropped');
  assert.equal(viewKeyMayRun(field, frame), false, 'a key the view posted while a Nendo field had focus ran');
  assert.equal(viewKeyMayRun(null, frame), false, 'a key the view posted with nothing focused ran');
  assert.equal(viewKeyMayRun(null, null), false, 'a key from a view without a frame ran');
});

test('a menu shows with the frame focused, or just after Nendo sent the view a command', () => {
  assert.equal(viewMenuMayShow(frame, frame, null, 10_000), true, 'a right-click inside the view drew no menu');
  assert.equal(viewMenuMayShow(field, frame, null, 10_000), false, 'a menu the view asked for on its own took focus from a Nendo field');
  assert.equal(viewMenuMayShow(field, frame, 10_000 - 100, 10_000), true, 'a menu answering a palette command was refused');
  assert.equal(viewMenuMayShow(field, frame, 10_000 - menuAfterCommandMs - 1, 10_000), false, 'a menu long after the command still showed');
});

test('the Workbench asks before it runs a handed-back key or draws a view menu', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/view-frames.ts', import.meta.url), 'utf8');
  const body = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf('\n}\n', source.indexOf(`function ${name}(`)));
  assert.match(body('keyFromView'), /^[^]*?\{\s*if \(!viewKeyMayRun\(document\.activeElement, mount\.frame\)\) return;/,
    'keyFromView runs a key before asking whether its frame has focus');
  assert.match(body('showMenuFor'), /if \(!viewMenuMayShow\(document\.activeElement, frame, mount\.commandAt, performance\.now\(\)\)\) return null;/,
    'showMenuFor draws a menu without asking');
  assert.match(body('sendCommand'), /if \(source === 'palette' \|\| source === 'key' \|\| source === 'add'\) mount\.commandAt = performance\.now\(\);/,
    'a command from the strip, its search box included, opens the window for a menu');
});
