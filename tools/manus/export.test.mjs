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

test('paper layout: bold headings kept, front matter centred, abstract and references set apart, pictures side by side', async () => {
  const paper = { title: 'A Paper', nodes: [
    { id: 'a', kind: 'Paragraph', text: '[Authors]' },
    { id: 'h0', kind: 'Chapter', text: 'Abstract' },
    { id: 'b', kind: 'Paragraph', text: 'We describe it.' },
    { id: 'h1', kind: 'Chapter', text: '1 Introduction' },
    { id: 'c', kind: 'Paragraph', text: 'First.' },
    { id: 'd', kind: 'Paragraph', text: 'Second.' },
    { id: 'p1', kind: 'Paragraph', text: `![One](${address})` },
    { id: 'p2', kind: 'Paragraph', text: `![Two](${address})` },
    { id: 'f', kind: 'Paragraph', text: '*Figure 1.* Two panels: (a) one; (b) two.' },
    { id: 'h2', kind: 'Chapter', text: 'References' },
    { id: 'r', kind: 'Paragraph', text: '[1] Someone. 2020. A Work.' },
  ] };
  const pictures = new Map([[address, { data: png, mediaType: 'image/png', width: 1600, height: 1000 }]]);
  const { document } = toDocx(exportPlan(paper), pictures, lib, Lexer, 'paper');
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(document));
  const xml = await zip.file('word/document.xml').async('string'), styles = await zip.file('word/styles.xml').async('string');
  assert.doesNotMatch(xml, /<w:b w:val="false"\/>/, 'a run switches bold off, which overrides a bold heading style');
  assert.match(styles, /w:styleId="Heading1"[\s\S]*?<w:b\/>/);
  const paragraph = text => xml.split('<w:p>').find(p => p.includes(text)) ?? '';
  assert.match(paragraph('[Authors]'), /<w:jc w:val="center"\/>/);
  assert.match(paragraph('We describe it.'), /<w:ind w:left="720" w:right="720"/);
  assert.doesNotMatch(paragraph('First.'), /w:firstLine="360"/, 'the first paragraph of a section is not indented');
  assert.match(paragraph('Second.'), /w:firstLine="360"/);
  assert.equal((paragraph('</w:drawing>').match(/<w:drawing>/g) ?? []).length, 2, 'two pictures next to each other share one row');
  assert.match(paragraph('Two panels'), /Figure 1: /);
  assert.match(paragraph('Someone. 2020'), /w:hanging="360"/);
  assert.match(await zip.file('word/document.xml').async('string'), /<w:pgSz w:w="12240" w:h="15840"/);
});

test('book layout: a 6 by 9 inch page with chapters on new pages', async () => {
  const { document } = toDocx(exportPlan(manuscript), new Map(), lib, Lexer, 'book');
  const xml = await (await lib.JSZip.loadAsync(await lib.Packer.toBuffer(document))).file('word/document.xml').async('string');
  assert.match(xml, /<w:pgSz w:w="8640" w:h="12960"/);
  assert.match(xml, /<w:pageBreakBefore\/>[\s\S]*?Part One/);
});

test('roles: a heading role reaches the paragraphs under it, and a block role wins over a guess', () => {
  const plan = exportPlan({ title: 'T', nodes: [
    { id: 'h', kind: 'Chapter', text: 'Summary', role: 'Abstract' },
    { id: 'a', kind: 'Paragraph', text: 'Inside the summary.' },
    { id: 'c', kind: 'Chapter', text: 'References', role: null },
    { id: 'r', kind: 'Paragraph', text: '[1] A work.' },
    { id: 'q', kind: 'Paragraph', text: 'Quoted.', role: 'Quotation' },
  ] });
  assert.deepEqual(plan.items.map(i => i.role), ['Abstract', 'Abstract', 'References', 'References', 'Quotation']);
});

test('roles beyond papers: epigraph, dedication, verse, quotation and scene break in Word and Markdown', async () => {
  const book = { title: 'Low Water', nodes: [
    { id: 'd', kind: 'Paragraph', text: 'For my grandfather', role: 'Dedication' },
    { id: 'c', kind: 'Chapter', text: 'One' },
    { id: 'e', kind: 'Paragraph', text: 'The sea has many voices.', role: 'Epigraph' },
    { id: 'p', kind: 'Paragraph', text: 'It rained.' },
    { id: 's', kind: 'Paragraph', text: '', role: 'Scene break' },
    { id: 'v', kind: 'Paragraph', text: 'Low water, slow water\\nthe bar keeps its own', role: 'Verse' },
    { id: 'q', kind: 'Paragraph', text: 'Boat seen beyond the bar.', role: 'Quotation' },
  ] };
  const plan = exportPlan(book);
  const markdown = toMarkdown(plan);
  assert.match(markdown, /\n\n\* \* \*\n\n/);
  assert.match(markdown, /\n\n> Boat seen beyond the bar\.\n/);
  assert.match(markdown, /\n\n> The sea has many voices\.\n/);
  const xml = await (await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, 'book').document))).file('word/document.xml').async('string');
  const paragraph = text => xml.split('<w:p>').find(p => p.includes(text)) ?? '';
  assert.match(paragraph('For my grandfather'), /<w:jc w:val="center"\/>/);
  assert.match(paragraph('For my grandfather'), /<w:i\/>/);
  assert.match(paragraph('many voices'), /<w:i\/>/);
  assert.match(paragraph('many voices'), /<w:ind w:left="2592"\/>/);
  assert.match(paragraph('* * *'), /<w:jc w:val="center"\/>/);
  assert.match(paragraph('slow water'), /<w:ind w:left="720"\/>/);
  assert.match(paragraph('slow water'), /<w:jc w:val="left"\/>/);
  assert.match(paragraph('beyond the bar'), /<w:ind w:left="720" w:right="720"\/>/);
  assert.doesNotMatch(paragraph('It rained.'), /w:firstLine="360"/, 'the first paragraph after an epigraph is not indented');
});
