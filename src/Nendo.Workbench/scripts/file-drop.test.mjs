import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// A .nendo file dragged onto the window (W-048).
//
// What is asserted here is the part that decides: how much the page is allowed to
// promise while a drag is still in the air, and what it does with what actually
// landed. The rest of the journey — the overlay appearing, the host being handed the
// file, Windows resolving its path — is the gate's and the owner's, because none of
// it is reachable from a bundle.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { describeDrag, judgeDrop } = await bundleOf('src/file-drop.ts');

test('a drag carrying nothing is not a drag worth answering', () => {
  assert.equal(describeDrag(0), null);
  assert.equal(describeDrag(-1), null);
});

test('one file is an offer and several is a refusal, before either name is known', () => {
  assert.deepEqual(describeDrag(1), { message: 'Drop to open this file', possible: true });
  const many = describeDrag(3);
  assert.equal(many.possible, false);
  assert.match(many.message, /one file at a time/);
});

test('the hint never claims the file is a Nendo file, because the page cannot see its name', () => {
  // A browser withholds the name until the drop. A hint saying "Drop to open this
  // Nendo file" over a dragged spreadsheet would be the page inventing what it knows.
  assert.doesNotMatch(describeDrag(1).message, /nendo/i);
});

test('one Nendo file is taken', () => {
  assert.deepEqual(judgeDrop(['Work.nendo']), { accept: 0, refusal: null });
  assert.deepEqual(judgeDrop(['WORK.NENDO']), { accept: 0, refusal: null });
});

test('anything else is refused, and the refusal names what was dropped', () => {
  const wrong = judgeDrop(['budget.xlsx']);
  assert.equal(wrong.accept, null);
  assert.match(wrong.refusal, /budget\.xlsx/);
  assert.match(wrong.refusal, /\.nendo/);
});

test('a name that merely contains .nendo is not a Nendo file', () => {
  // endsWith is the guard; a looser test would accept the backup an editor leaves
  // beside the real file, and the host would then be asked to open a .bak.
  assert.equal(judgeDrop(['Work.nendo.bak']).accept, null);
  assert.match(judgeDrop(['Work.nendo.bak']).refusal, /Work\.nendo\.bak/);
  assert.equal(judgeDrop(['nendo.txt']).accept, null);
});

test('a file called only .nendo is a dotfile, not a Nendo file', () => {
  // endsWith alone accepts it, and the host would then try to open a file whose whole
  // name is the extension. Cheap to get wrong and impossible to notice by hand.
  assert.equal(judgeDrop(['.nendo']).accept, null);
});

test('several files are refused with the count, not silently reduced to the first', () => {
  const many = judgeDrop(['a.nendo', 'b.nendo']);
  assert.equal(many.accept, null);
  assert.match(many.refusal, /2 files/);
});

test('an empty drop says nothing at all', () => {
  assert.deepEqual(judgeDrop([]), { accept: null, refusal: null });
});
