import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// Nendo's top bar as the window's title bar (W-093): what the page claims of the bar, through
// the real module. title-bar.ts measures the boxes; the Desktop journey measures the window.
const bundle = await build({
  configFile: false, logLevel: 'error',
  build: { ssr: 'src/title-bar-model.ts', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const model = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
const bar = { height: 48, left: 0, right: 144 };

test('a control is claimed inside the bar only, grown outwards to whole pixels', () => {
  const claimed = model.titleBarControls([
    { x: 551.2, y: 10, width: 32, height: 32 },
    { x: 161.3, y: 8.7, width: 30, height: 30 },
    // A control that runs below the bar is claimed down to its edge, not beyond.
    { x: 20, y: 30, width: 40, height: 40 },
  ], bar, 1052, false);
  assert.deepEqual(claimed, [
    { x: 20, y: 30, width: 40, height: 18 },
    { x: 161, y: 8, width: 31, height: 31 },
    { x: 551, y: 10, width: 33, height: 32 },
  ]);
});

test('a box inside another is claimed once, and so is a box drawn twice', () => {
  const claimed = model.titleBarControls([
    { x: 100, y: 8, width: 120, height: 32 },
    { x: 110, y: 10, width: 90, height: 28 },
    { x: 300, y: 8, width: 30, height: 30 },
    { x: 300, y: 8, width: 30, height: 30 },
  ], bar, 1052, false);
  assert.deepEqual(claimed, [{ x: 100, y: 8, width: 120, height: 32 }, { x: 300, y: 8, width: 30, height: 30 }]);
});

test('nothing outside the bar, off the page or without a size is claimed', () => {
  assert.deepEqual(model.titleBarControls([
    { x: 10, y: 60, width: 30, height: 30 },
    { x: 1100, y: 8, width: 30, height: 30 },
    { x: 10, y: 8, width: 0, height: 30 },
    { x: -50, y: -50, width: 20, height: 20 },
  ], bar, 1052, false), []);
  // A control cut by the page's right edge is claimed up to it.
  assert.deepEqual(model.titleBarControls([{ x: 1040, y: 8, width: 30, height: 30 }], bar, 1052, false),
    [{ x: 1040, y: 8, width: 12, height: 30 }]);
});

test('an open menu or dialog, or more controls than the host takes, claims the whole bar up to the window’s buttons', () => {
  // 1052 wide, less the 144 Windows keeps for Minimise, Maximise and Close.
  const whole = [{ x: 0, y: 0, width: 908, height: 48 }];
  assert.deepEqual(model.titleBarControls([{ x: 10, y: 8, width: 30, height: 30 }], bar, 1052, true), whole);
  assert.deepEqual(model.titleBarControls([], { height: 48, left: 0, right: 0 }, 1051.5, true), [{ x: 0, y: 0, width: 1052, height: 48 }]);
  assert.deepEqual(model.titleBarControls([], bar, 100, true), []);
  const many = Array.from({ length: model.maximumTitleBarControls + 1 }, (_, index) => ({ x: index * 12, y: 8, width: 10, height: 30 }));
  assert.deepEqual(model.titleBarControls(many, bar, 1052, false), whole);
  const most = many.slice(1);
  assert.equal(model.titleBarControls(most, bar, 1052, false).length, model.maximumTitleBarControls);
});

test('the bar the host answers with is read within bounds, and anything else is refused', () => {
  assert.deepEqual(model.readTitleBar({ height: 48, left: 0, right: 144, extra: 'ignored' }), { height: 48, left: 0, right: 144 });
  for (const value of [null, 'bar', { height: 48, left: 0 }, { height: -1, left: 0, right: 0 }, { height: 48, left: 0, right: Infinity },
    { height: 48, left: 0, right: '144' }, { height: 201, left: 0, right: 0 }, { height: 48, left: 1001, right: 0 }])
    assert.equal(model.readTitleBar(value), null, JSON.stringify(value));
  assert.equal(model.sameTitleBar({ height: 48, left: 0, right: 144 }, { height: 48, left: 0, right: 144 }), true);
  assert.equal(model.sameTitleBar({ height: 48, left: 0, right: 144 }, { height: 48, left: 0, right: 138 }), false);
  assert.equal(model.sameTitleBar(null, { height: 48, left: 0, right: 144 }), false);
});

test('a report is sent again only when a box moved', () => {
  const boxes = [{ x: 1, y: 2, width: 3, height: 4 }];
  assert.equal(model.sameBoxes(boxes, [{ x: 1, y: 2, width: 3, height: 4 }]), true);
  assert.equal(model.sameBoxes(boxes, [{ x: 1, y: 2, width: 3, height: 5 }]), false);
  assert.equal(model.sameBoxes(boxes, []), false);
});
