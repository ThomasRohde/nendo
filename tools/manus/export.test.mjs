import assert from 'node:assert/strict';
import test from 'node:test';
import { Lexer } from '../../extensions/manuscript/vendor/editor.js';
import * as lib from '../../extensions/manuscript/vendor/export.js';
import { exportPlan, safeName, pictureFiles, toMarkdown, toDocx } from '../../extensions/manuscript/export.mjs';

const address = `media:${'cd'.repeat(32)}`;
const manuscript = { title: 'Low Water', nodes: [
  { id: 'p1', kind: 'Part', text: 'Part One' },
  { id: 'c3', kind: 'Chapter', text: 'The Tide Table' },
  { id: 'a', kind: 'Paragraph', text: 'It promised low water at *4:12*. **Never** that precise.' },
  { id: 'e', kind: 'Paragraph', text: '' },
  { id: 'pic', kind: 'Paragraph', text: `![The harbour at dawn](${address})` },
  { id: 's', kind: 'Section', text: 'Ebb' },
  { id: 'b', kind: 'Paragraph', text: 'Outside, the water pulled back.' },
] };
// The smallest PNG there is: one transparent pixel.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

test('the plan: headings from level 1, empty paragraphs left out, pictures by address', () => {
  const plan = exportPlan(manuscript);
  assert.equal(plan.title, 'Low Water');
  assert.deepEqual(plan.items.map(i => [i.type, i.level ?? null]), [['heading', 1], ['heading', 2], ['paragraph', null], ['picture', null], ['heading', 3], ['paragraph', null]]);
  assert.equal(exportPlan({ title: ' ', nodes: [{ id: 'c', kind: 'Chapter', text: 'One' }] }).items[0].level, 1);
  assert.equal(exportPlan({ title: '', nodes: [] }).title, 'Untitled manuscript');
});

test('Markdown: the title, headings one level under it, the text as written, pictures in media/', () => {
  const plan = exportPlan(manuscript);
  const files = pictureFiles(plan, new Map([[address, { mediaType: 'image/jpeg' }]]));
  assert.deepEqual([...files.values()], ['media/picture-01.jpg']);
  assert.equal(toMarkdown(plan, files), [
    '# Low Water', '## Part One', '### The Tide Table', 'It promised low water at *4:12*. **Never** that precise.',
    '![The harbour at dawn](media/picture-01.jpg)', '#### Ebb', 'Outside, the water pulled back.',
  ].join('\n\n') + '\n');
  // A picture that was not read keeps its address, and nothing is dropped.
  assert.match(toMarkdown(plan), new RegExp(`!\\[The harbour at dawn\\]\\(${address}\\)`));
});

test('a file name Windows takes', () => {
  assert.equal(safeName('Milo: and the "Paper" Boat?'), 'Milo and the Paper Boat');
  assert.equal(safeName('...'), 'Manuscript');
  assert.equal(safeName(''), 'Manuscript');
});

test('Word: a real document with Title and Heading styles, styled runs and the picture embedded', async () => {
  const plan = exportPlan(manuscript);
  const { document, missing } = toDocx(plan, new Map([[address, { data: png, mediaType: 'image/png', width: 1, height: 1 }]]), lib, Lexer);
  assert.deepEqual(missing, []);
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(document));
  const xml = await zip.file('word/document.xml').async('string');
  for (const style of ['Title', 'Heading1', 'Heading2', 'Heading3']) assert.match(xml, new RegExp(`<w:pStyle w:val="${style}"/>`), style);
  assert.match(xml, /<w:b\/>[\s\S]*?Never/);
  assert.match(xml, /<w:i\/>[\s\S]*?4:12/);
  assert.match(xml, /descr="The harbour at dawn"/);
  assert.ok(Object.keys(zip.files).some(name => name.startsWith('word/media/')), 'the picture is not in the package');
});

test('Word: a picture that could not be read stands as its description and is named', async () => {
  const { document, missing } = toDocx(exportPlan(manuscript), new Map(), lib, Lexer);
  assert.deepEqual(missing.map(m => [m.alt, m.why]), [['The harbour at dawn', 'not read']]);
  const xml = await (await lib.JSZip.loadAsync(await lib.Packer.toBuffer(document))).file('word/document.xml').async('string');
  assert.match(xml, /\[Picture: The harbour at dawn\]/);
});
