import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// The owner could not drop a picture into the agent's message box. The box takes pictures for an
// agent that reads them, within the host's bounds, and says why when it takes none.
const { maximumPictureBytes, maximumPictures, pastedName, pictureChunkBytes, pictureChunks, picturesMarkup, takePictures } =
  await bundleOf('src/agent-image-model.ts');

const png = (name, size = 1000) => ({ name, type: 'image/png', size });

test('an agent that reads pictures takes them; any other takes none and says so', () => {
  assert.deepEqual(takePictures([], [png('a.png'), png('b.png')], true, 'Claude'), { accepted: [0, 1], note: null });
  const refused = takePictures([], [png('a.png')], false, 'Gemini');
  assert.deepEqual(refused.accepted, []);
  assert.match(refused.note, /Gemini does not read pictures/);
});

test('only the picture types a model reads, each within its bound and all within theirs', () => {
  const mixed = takePictures([], [
    png('ok.png'),
    { name: 'notes.pdf', type: 'application/pdf', size: 10 },
    { name: 'logo.svg', type: 'image/svg+xml', size: 10 },
    png('huge.png', maximumPictureBytes + 1),
    png('empty.png', 0),
  ], true, 'Claude');
  assert.deepEqual(mixed.accepted, [0]);
  for (const name of ['notes.pdf', 'logo.svg', 'huge.png', 'empty.png']) assert.match(mixed.note, new RegExp(name.replace('.', '\\.')));

  const full = Array.from({ length: maximumPictures }, (_, index) => png(`${index}.png`));
  const ninth = takePictures(full, [png('ninth.png')], true, 'Claude');
  assert.deepEqual(ninth.accepted, []);
  assert.match(ninth.note, /8 pictures at most; ninth\.png/);

  const heavy = Array.from({ length: 4 }, (_, index) => png(`${index}.png`, 4.9 * 1024 * 1024));
  const fifth = takePictures(heavy, [png('fifth.png', 1024 * 1024)], true, 'Claude');
  assert.deepEqual(fifth.accepted, []);
  assert.match(fifth.note, /20 MB of pictures at most/);
});

test('a pasted picture is numbered, since the clipboard names each one image.png', () => {
  assert.equal(pastedName('image/png', 1), 'Pasted picture 1.png');
  assert.equal(pastedName('image/jpeg', 2), 'Pasted picture 2.jpg');
});

test('a chip draws the name as text and removes by its own key', () => {
  const hostile = '<img src=x onerror="alert(1)">.png';
  const markup = picturesMarkup([{ key: 'picture-1', name: hostile, type: 'image/png', size: 2048 }]);
  assert.ok(!markup.includes('<img src=x'), markup);
  assert.match(markup, /data-remove-picture="picture-1"/);
  assert.match(markup, /2 KB/);
});

test('a picture is cut into chunks that fit one bridge message and join back whole', () => {
  const bytes = new Uint8Array(pictureChunkBytes * 2 + 17).map((_, index) => (index * 31) & 0xff);
  const chunks = pictureChunks(bytes);
  assert.deepEqual(chunks.map((chunk) => chunk.offset), [0, pictureChunkBytes, pictureChunkBytes * 2]);
  for (const chunk of chunks) assert.ok(chunk.base64.length <= 200_000, `${chunk.base64.length} characters`);
  const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.base64, 'base64')));
  assert.deepEqual(new Uint8Array(joined), bytes);
});
