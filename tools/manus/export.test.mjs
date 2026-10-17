import assert from 'node:assert/strict';
import test from 'node:test';
import { Lexer } from '../../extensions/manuscript/vendor/editor.js';
import * as lib from '../../extensions/manuscript/vendor/export.js';
import { exportPlan, safeName, pictureFiles, toMarkdown, toDocx, paperHeadings, columnsStart, draftLine } from '../../extensions/manuscript/export.mjs';

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

test('Word and the plan: underline and highlight runs, and a block\'s own alignment over its layout\'s', async () => {
  const plan = exportPlan({ title: 'Marks', nodes: [
    { id: 'h', kind: 'Chapter', text: 'Signed off', align: 'Right' },
    { id: 'u', kind: 'Paragraph', text: 'An <u>underlined</u> word and a <mark>lit</mark> one.', align: null },
    { id: 'c', kind: 'Paragraph', text: 'Set in the middle.', align: 'Centre' },
    { id: 'l', kind: 'Paragraph', text: 'Ragged on the right.', align: 'Left' },
  ] });
  assert.deepEqual(plan.items.map(i => i.align), ['Right', null, 'Centre', 'Left']);
  for (const layout of ['book', 'paper']) {
    const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, layout).document));
    const xml = await zip.file('word/document.xml').async('string');
    // A paper sets a heading in capitals, with its number.
    const paragraph = words => xml.split('<w:p>').find(p => p.toLowerCase().includes(words.toLowerCase())) ?? '';
    assert.match(xml, /<w:u w:val="single"\/>[\s\S]*?underlined/, layout);
    assert.match(xml, /<w:highlight w:val="yellow"\/>[\s\S]*?lit/, layout);
    assert.match(paragraph('Set in the middle.'), /<w:jc w:val="center"\/>/, layout);
    assert.match(paragraph('Ragged on the right.'), /<w:jc w:val="left"\/>/, layout);
    assert.match(paragraph('Signed off'), /<w:jc w:val="right"\/>/, layout);
    // A block with no alignment of its own keeps its layout's: body text justified.
    assert.match(paragraph('underlined'), /<w:jc w:val="both"\/>/, layout);
  }
});

test('Word: a picture that could not be read stands as its description and is named', async () => {
  const { document, missing } = toDocx(exportPlan(manuscript), new Map(), lib, Lexer);
  assert.deepEqual(missing.map(m => [m.alt, m.why]), [['The harbour at dawn', 'not read']]);
  const xml = await (await lib.JSZip.loadAsync(await lib.Packer.toBuffer(document))).file('word/document.xml').async('string');
  assert.match(xml, /\[Picture: The harbour at dawn\]/);
});

test('paper layout: AASTeX two columns, front matter centred, abstract and references set apart, pictures side by side', async () => {
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
  const { document } = toDocx(exportPlan(paper), pictures, lib, Lexer, 'paper', { date: new Date(2026, 9, 16) });
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(document));
  const xml = await zip.file('word/document.xml').async('string'), styles = await zip.file('word/styles.xml').async('string');
  assert.doesNotMatch(xml, /<w:b w:val="false"\/>/, 'a run switches bold off, which overrides a bold heading style');
  const paragraph = text => xml.split('<w:p>').find(p => p.includes(text)) ?? '';
  assert.match(paragraph('[Authors]'), /<w:jc w:val="center"\/>/);
  assert.match(paragraph('We describe it.'), /<w:ind w:left="680" w:right="680" w:firstLine="288"/, 'the abstract is narrower, every paragraph indented');
  assert.doesNotMatch(paragraph('First.'), /w:firstLine="288"/, 'the first paragraph of a section is not indented');
  assert.match(paragraph('Second.'), /w:firstLine="288"/);
  assert.equal((paragraph('</w:drawing>').match(/<w:drawing>/g) ?? []).length, 2, 'two pictures next to each other share one row');
  assert.match(paragraph('Two panels'), /Figure 1\. /);
  assert.match(paragraph('Someone. 2020'), /w:hanging="216"/);
  assert.match(xml, /<w:pgSz w:w="12240" w:h="15840"/);
  // Headings as AASTeX sets them: numbered sections and parts in capitals, centred, not bold.
  assert.ok(xml.includes('>1. INTRODUCTION<') && xml.includes('>ABSTRACT<') && xml.includes('>REFERENCES<'));
  assert.doesNotMatch(styles.split('w:styleId="Heading1"')[1].split('</w:style>')[0], /<w:b\/>/);
  // The abstract runs across the page; the body after it in two columns on the same page.
  const sections = xml.split('<w:sectPr');
  assert.equal(sections.length, 3, 'two sections');
  assert.match(sections[2], /<w:type w:val="continuous"\/>/);
  assert.match(sections[2], /<w:cols[^>]*w:num="2"/);
  assert.ok(xml.indexOf('We describe it.') < xml.indexOf('<w:sectPr') && xml.indexOf('1. INTRODUCTION') > xml.indexOf('<w:sectPr'));
  const headers = await Promise.all(Object.keys(zip.files).filter(name => /^word\/header\d+\.xml$/.test(name)).map(name => zip.file(name).async('string')));
  assert.ok(headers.some(h => h.includes('Draft version October 16, 2026') && h.includes('<w:smallCaps/>')), 'the first page carries the draft line');
});

test('paper headings: numbered as AASTeX numbers them, a heading\'s own number kept, parts at any depth in capitals', () => {
  const plan = exportPlan({ title: 'T', nodes: [
    { id: 'a', kind: 'Section', text: 'Abstract' }, { id: 'p', kind: 'Paragraph', text: 'Text.' },
    { id: 'c1', kind: 'Chapter', text: 'Introduction' }, { id: 's1', kind: 'Section', text: 'Scope' },
    { id: 'c2', kind: 'Chapter', text: '4 System' }, { id: 's2', kind: 'Section', text: '4.2 Studio' }, { id: 's3', kind: 'Section', text: 'Next' },
    { id: 'c3', kind: 'Chapter', text: 'Conclusion' }, { id: 'r', kind: 'Chapter', text: 'References' }, { id: 'rs', kind: 'Section', text: 'Software' },
  ] });
  const { labels, parts } = paperHeadings(plan);
  const heading = id => plan.items.find(i => i.id === id);
  assert.deepEqual(['a', 'c1', 's1', 'c2', 's2', 's3', 'c3', 'r', 'rs'].map(id => labels.get(heading(id))),
    ['ABSTRACT', '1. INTRODUCTION', '1.1. Scope', '4. SYSTEM', '4.2. Studio', '4.3. Next', '5. CONCLUSION', 'REFERENCES', 'Software']);
  assert.ok(parts.has(heading('a')) && parts.has(heading('r')) && !parts.has(heading('rs')));
  assert.equal(columnsStart(plan), 2, 'the columns start at the first heading after the abstract');
  // The editor saves a heading that starts "4.4" as "4\\.4", so Markdown does not read a list item.
  const saved = exportPlan({ title: 'T', nodes: [{ id: 'c', kind: 'Chapter', text: '4 System' }, { id: 's', kind: 'Section', text: '4\\.4 History' }] });
  assert.equal(paperHeadings(saved).labels.get(saved.items[1]), '4.4. History');
  assert.equal(draftLine(new Date(2026, 9, 16)), 'Draft version October 16, 2026');
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

test('lists: markers as the sheet numbers them, Markdown lists, and Word numbering that starts again for each list', async () => {
  const plan = exportPlan({ title: 'Lists', nodes: [
    { id: 'p', kind: 'Paragraph', text: 'Before.' },
    { id: 'a', kind: 'Paragraph', text: 'Tide', list: 'Numbered', level: 0 },
    { id: 'b', kind: 'Paragraph', text: 'Low', list: 'Numbered', level: 1 },
    { id: 'c', kind: 'Paragraph', text: 'High', list: 'Numbered', level: 1 },
    { id: 'd', kind: 'Paragraph', text: 'Wind', list: 'Bulleted', level: 2 },
    { id: 'e', kind: 'Paragraph', text: 'Ledger', list: 'Numbered', level: 0 },
    { id: 'q', kind: 'Paragraph', text: 'Between.' },
    { id: 'f', kind: 'Paragraph', text: 'Again', list: 'Numbered', level: 0 },
    { id: 'g', kind: 'Paragraph', text: 'Dot', list: 'Bulleted', level: 0 },
  ] });
  assert.deepEqual(plan.items.map(i => i.marker ?? null), [null, '1.', 'a.', 'b.', '▪', '2.', null, '1.', '•']);
  assert.deepEqual(plan.items.filter(i => i.list === 'Numbered').map(i => i.run), [1, 1, 1, 1, 2]);
  assert.equal(toMarkdown(plan), ['# Lists', 'Before.', '1. Tide\n    1. Low\n    1. High\n        - Wind\n1. Ledger', 'Between.', '1. Again\n- Dot'].join('\n\n') + '\n');
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, 'book').document));
  const xml = await zip.file('word/document.xml').async('string'), numbering = await zip.file('word/numbering.xml').async('string');
  const numOf = words => /<w:numId w:val="(\d+)"\/>/.exec(xml.split('<w:p>').find(p => p.includes(words)) ?? '')?.[1];
  const ilvlOf = words => /<w:ilvl w:val="(\d+)"\/>/.exec(xml.split('<w:p>').find(p => p.includes(words)) ?? '')?.[1];
  assert.ok(numOf('Tide') && numOf('Tide') === numOf('Ledger') && numOf('Again') !== numOf('Tide'), `numbering instances: ${[numOf('Tide'), numOf('Ledger'), numOf('Again')]}`);
  assert.deepEqual([ilvlOf('Tide'), ilvlOf('Low'), ilvlOf('Wind')], ['0', '1', '2']);
  assert.ok(numOf('Wind') && numOf('Wind') !== numOf('Tide'), 'a bulleted item uses the bullet list');
  assert.match(numbering, /<w:numFmt w:val="lowerLetter"\/>/);
  assert.match(numbering, /<w:numFmt w:val="bullet"\/>/);
  assert.equal(numOf('Before.'), undefined);
});

test('tables: one plan item of rows, a pipe table in Markdown, and a Word table with its header row', async () => {
  const plan = exportPlan({ title: 'Tables', nodes: [
    { id: 'h', kind: 'Chapter', text: 'Posts' },
    { id: 't', kind: 'Table', text: '' },
    { id: 'r1', kind: 'Row', text: '' }, { id: 'c1', kind: 'Cell', text: 'Post' }, { id: 'c2', kind: 'Cell', text: 'Depth' },
    { id: 'r2', kind: 'Row', text: '' }, { id: 'c3', kind: 'Cell', text: '*4*' }, { id: 'c4', kind: 'Cell', text: 'a | b\\\nc' },
    { id: 'r3', kind: 'Row', text: '' }, { id: 'c5', kind: 'Cell', text: '9' },
    { id: 'p', kind: 'Paragraph', text: 'After.' },
  ] });
  assert.deepEqual(plan.items.map(i => i.type), ['heading', 'table', 'paragraph']);
  assert.deepEqual(plan.items[1].rows, [['Post', 'Depth'], ['*4*', 'a | b\\\nc'], ['9']]);
  assert.equal(toMarkdown(plan), ['# Tables', '## Posts', '| Post | Depth |\n| --- | --- |\n| *4* | a \\| b<br>c |\n| 9 |  |', 'After.'].join('\n\n') + '\n');
  for (const layout of ['book', 'paper']) {
    const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, layout).document));
    const xml = await zip.file('word/document.xml').async('string');
    assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 1, layout);
    assert.equal((xml.match(/<w:tr>|<w:tr /g) ?? []).length, 3, layout);
    assert.equal((xml.match(/<w:tc>/g) ?? []).length, 6, `${layout}: a short row is filled out`);
    assert.match(xml, /<w:tblHeader\/>/, layout);
    assert.match(xml, /<w:b\/>[\s\S]*?Post/, layout);
    assert.match(xml, /<w:i\/>[\s\S]*?>4</, layout);
  }
});
