import assert from 'node:assert/strict';
import test from 'node:test';
import { Lexer } from '../../extensions/manuscript/vendor/editor.js';
import * as lib from '../../extensions/manuscript/vendor/export.js';
import { exportPlan, safeName, pictureFiles, toMarkdown, toDocx, packDocx, paperHeadings, columnsStart, draftLine, withProfile, LAYOUTS, ARTICLE, tableColumns } from '../../extensions/manuscript/export.mjs';
import { setLines, softHyphens, termesWidth, timesWidth } from '../../extensions/manuscript/typeset.mjs';
import { hyphenate } from '../../extensions/manuscript/hyphenation.mjs';

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
/**
 * A paragraph as Word formats it: its own XML and the definition of the paragraph style it names,
 * where a role's indent, alignment and type now live.
 */
const asFormatted = (xml, styles) => words => {
  const own = xml.split('<w:p>').find(p => p.toLowerCase().includes(words.toLowerCase())) ?? '';
  const id = /<w:pStyle w:val="([^"]+)"\/>/.exec(own)?.[1];
  return own + (id ? styles.split('<w:style ').find(s => s.includes(`w:styleId="${id}"`)) ?? '' : '');
};

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
    const paragraph = asFormatted(xml, await zip.file('word/styles.xml').async('string'));
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
  const paragraph = asFormatted(xml, styles);
  assert.match(paragraph('[Authors]'), /<w:jc w:val="center"\/>/);
  // AASTeX's measures: the abstract 444 TeX points wide, every paragraph indented 9 points,
  // the first after a heading too, on lines exactly 12.5 TeX points apart.
  assert.match(paragraph('We describe it.'), /<w:ind w:left="677" w:right="700" w:firstLine="179"/, 'the abstract is 444pt wide, as AASTeX sets it, every paragraph indented 9pt');
  assert.match(paragraph('First.'), /w:firstLine="180"/, 'an article indents the first paragraph after a heading too');
  assert.match(paragraph('Second.'), /w:firstLine="180"/);
  assert.match(paragraph('Second.'), /w:line="249" w:lineRule="exact"/);
  assert.equal((paragraph('</w:drawing>').match(/<w:drawing>/g) ?? []).length, 2, 'two pictures next to each other share one row');
  assert.match(paragraph('Two panels'), /Figure 1\. /);
  assert.match(paragraph('Someone. 2020'), /w:hanging="179"/);
  assert.match(xml, /<w:pgSz w:w="12240" w:h="15840"/);
  // The page: 7.1 inches of text from 50.74 points in, TeX's two 242.27pt columns 28.58pt apart, the
  // first baseline of a column at 74.6 and the last no lower than 716.85 (Word sets a line's
  // baseline 0.8 of its height below its top).
  assert.match(xml, /<w:pgMar w:top="1293" w:right="1001" w:bottom="1453" w:left="1015" w:header="833"/);
  assert.match(xml, /<w:cols w:space="570" w:num="2"\/>/);
  assert.equal(Math.round((1293 / 20 + 0.8 * ARTICLE.pitch) * 10) / 10, ARTICLE.top);
  // Headings as AASTeX sets them: numbered sections and parts in capitals, centred, not bold.
  assert.ok(xml.includes('>1. INTRODUCTION<') && xml.includes('>ABSTRACT<') && xml.includes('>REFERENCES<'));
  assert.doesNotMatch(styles.split('w:styleId="Heading1"')[1].split('</w:style>')[0], /<w:b\/>/);
  // The abstract runs across the page; the body after it in two columns on the same page.
  // Across the page, two columns, the references' heading across, their two columns, and an
  // empty last section so that Word balances the last page's columns, as AASTeX does.
  const sections = xml.split('<w:sectPr');
  assert.equal(sections.length, 6, 'five sections');
  assert.match(sections[2], /<w:type w:val="continuous"\/>/);
  assert.match(sections[2], /<w:cols[^>]*w:num="2"/);
  assert.doesNotMatch(sections[3], /<w:cols[^>]*w:num="2"/);
  assert.ok(sections[3].indexOf('>REFERENCES<') < 0 && sections[2].includes('>REFERENCES<'), 'the references heading ends the third section');
  assert.match(sections[4], /<w:cols[^>]*w:num="2"/);
  const settings = await zip.file('word/settings.xml').async('string');
  assert.match(settings, /<w:autoHyphenation\/>/, 'an article hyphenates, as TeX does');
  assert.match(settings, /<w:evenAndOddHeaders\/>/, 'page numbers on the outer side');
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
  const roleZip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, 'book').document));
  const xml = await roleZip.file('word/document.xml').async('string'), styles = await roleZip.file('word/styles.xml').async('string');
  const paragraph = asFormatted(xml, styles);
  // Each role is a named paragraph style, its formatting in the style, not on the paragraph.
  for (const [words, style, name] of [['For my grandfather', 'Dedication', 'Dedication'], ['many voices', 'Epigraph', 'Epigraph'], ['slow water', 'Verse', 'Verse'],
    ['beyond the bar', 'Quotation', 'Quotation'], ['* * *', 'SceneBreak', 'Scene Break'], ['It rained.', 'BodyTextFirst', 'Body Text First']]) {
    const own = xml.split('<w:p>').find(p => p.includes(words)) ?? '';
    assert.match(own, new RegExp(`<w:pStyle w:val="${style}"/>`), `${words} is not in ${style}`);
    assert.doesNotMatch(own, /<w:ind |<w:jc /, `${words} carries its formatting itself`);
    assert.match(styles, new RegExp(`<w:style w:type="paragraph" w:styleId="${style}"[^>]*>\\s*<w:name w:val="${name}"/>`), `no style named ${name}`);
  }
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

test('no author text is lost: every paragraph, heading and cell of the plan is in the Markdown and the Word document', async () => {
  const book = { title: 'Low Water', nodes: [
    { id: 'c', kind: 'Chapter', text: 'One' },
    { id: 'p', kind: 'Paragraph', text: 'It rained.' },
    { id: 's', kind: 'Paragraph', text: 'Three years later', role: 'Scene break' },
    { id: 'e', kind: 'Paragraph', text: '', role: 'Scene break' },
    // A heading with a role passes it to every paragraph under it.
    { id: 'h', kind: 'Section', text: 'Interlude', role: 'Scene break' },
    { id: 'u', kind: 'Paragraph', text: 'The bar was quiet.' },
    { id: 'v', kind: 'Paragraph', text: 'Low water, slow water', role: 'Verse' },
    { id: 'q', kind: 'Paragraph', text: 'Boat seen beyond the bar.', role: 'Quotation' },
    { id: 'l', kind: 'Paragraph', text: 'Tide', list: 'Numbered', level: 0 },
    { id: 't', kind: 'Table' }, { id: 'r', kind: 'Row' }, { id: 'x', kind: 'Cell', text: 'Harbour' },
  ] };
  const plan = exportPlan(book);
  const words = plan.items.flatMap(i => i.type === 'table' ? i.rows.flat() : [i.text ?? '']).filter(t => t.trim());
  assert.ok(words.includes('Three years later') && words.includes('The bar was quiet.'));
  const markdown = toMarkdown(plan);
  const xml = await (await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, 'book').document))).file('word/document.xml').async('string');
  for (const text of words) {
    assert.ok(markdown.includes(text), `Markdown lost "${text}"`);
    assert.ok(xml.includes(text), `Word lost "${text}"`);
  }
  assert.match(markdown, /\n\n\* \* \*\n\n/, 'an empty scene break is still the three stars');
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
    // A book's header row is bold; an article's is plain, under AASTeX's rules.
    if (layout === 'book') assert.match(xml, /<w:b\/>[\s\S]*?Post/, layout);
    else {
      assert.doesNotMatch(xml, /<w:b\/>[\s\S]*?Post/, layout);
      assert.match(xml, /<w:top w:val="double"[^>]*\/>[\s\S]*<w:insideV w:val="none"/, 'a double rule above, no rules between columns');
    }
    assert.match(xml, /<w:i\/>[\s\S]*?>4</, layout);
  }
});

test('a web link is a hyperlink in Word and stays [words](address) in Markdown', async () => {
  const plan = exportPlan({ title: 'Links', nodes: [{ id: 'p', kind: 'Paragraph', text: 'See [the tide table](https://example.org/tides) first.' }] });
  assert.match(toMarkdown(plan), /See \[the tide table\]\(https:\/\/example\.org\/tides\) first\./);
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, 'book').document));
  const xml = await zip.file('word/document.xml').async('string'), rels = await zip.file('word/_rels/document.xml.rels').async('string');
  const id = /<w:hyperlink[^>]* r:id="([^"]+)"[^>]*>(?:(?!<\/w:hyperlink>).)*the tide table/s.exec(xml)?.[1];
  assert.ok(id, 'the words are inside a w:hyperlink');
  assert.match(rels, new RegExp(`Id="${id}"[^>]*Target="https://example.org/tides"[^>]*TargetMode="External"|Target="https://example.org/tides"[^>]*TargetMode="External"[^>]*Id="${id}"`));
});

test('footnotes: numbered as first cited, Markdown footnotes, and Word\'s own footnotes', async () => {
  const plan = exportPlan({ title: 'Notes', footnotes: new Map([['b-fa', { text: 'First, *in italics*.' }], ['b-fb', { text: 'Second.' }]]), nodes: [
    { id: 'p', kind: 'Paragraph', text: 'The bar[^b-fb] was dry[^b-fa].' },
    { id: 'q', kind: 'Paragraph', text: 'Again[^b-fb].' },
  ] });
  assert.deepEqual(plan.footnotes.map(f => [f.n, f.id]), [[1, 'b-fb'], [2, 'b-fa']]);
  const markdown = toMarkdown(plan);
  assert.match(markdown, /The bar\[\^1\] was dry\[\^2\]\./);
  assert.match(markdown, /Again\[\^1\]\./);
  assert.match(markdown, /\n\[\^1\]: Second\.\n\[\^2\]: First, \*in italics\*\.\n$/);
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, 'book').document));
  const xml = await zip.file('word/document.xml').async('string'), notes = await zip.file('word/footnotes.xml').async('string');
  assert.equal((xml.match(/<w:footnoteReference w:id="1"\/>/g) ?? []).length, 2, 'both citations of the first footnote');
  assert.match(xml, /<w:footnoteReference w:id="2"\/>/);
  assert.match(notes, /<w:footnote w:id="1">.*Second\..*<\/w:footnote>/s);
  assert.match(notes, /<w:footnote w:id="2">.*First, .*in italics.*<\/w:footnote>/s);
});

test('the manuscript layout: Times at 12 points, double-spaced, on Letter with one-inch margins, chapters on new pages', async () => {
  const plan = exportPlan({ title: 'Low Water', nodes: [{ id: 'c', kind: 'Chapter', text: 'One' }, { id: 'p', kind: 'Paragraph', text: 'It rained.' }, { id: 'q', kind: 'Paragraph', text: 'Then it stopped.' }] });
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, 'manuscript').document));
  const xml = await zip.file('word/document.xml').async('string'), styles = await zip.file('word/styles.xml').async('string');
  assert.match(xml, /<w:pgSz w:w="12240" w:h="15840"/);
  assert.match(xml, /<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
  assert.match(styles, /<w:docDefaults>[\s\S]*w:ascii="Times New Roman"[\s\S]*<w:sz w:val="24"\/>[\s\S]*w:line="480"/);
  assert.match(asFormatted(xml, styles)('Then it stopped.'), /w:firstLine="720"/);
  assert.match(xml.split('<w:p>').find(p => p.includes('One')) ?? '', /<w:pageBreakBefore\/>/);
});

test('an output profile over a layout: page, margins, typeface, size with the headings scaled, spacing and page numbers', async () => {
  const profile = { page: 'A4', margin: 20, font: 'Cambria', size: 12, spacing: 'Double', numbers: false };
  const L = withProfile(LAYOUTS.book, profile);
  assert.deepEqual([L.page.width, L.page.height, L.page.margin, L.font, L.size, L.line, L.pageNumbers], [11906, 16838, 1134, 'Cambria', 24, 480, false]);
  assert.equal(L.headings[0].size, Math.round(32 * 24 / 22), 'headings keep their size against the body');
  assert.equal(LAYOUTS.book.page.width, 8640, 'the layout itself is left as it was');
  assert.deepEqual(withProfile(LAYOUTS.book, { page: null, margin: null, font: null, size: null, spacing: null, numbers: null }).page, LAYOUTS.book.page, 'empty choices keep the layout');
  const plan = exportPlan({ title: 'Low Water', nodes: [{ id: 'c', kind: 'Chapter', text: 'One' }, { id: 'p', kind: 'Paragraph', text: 'It rained.' }] });
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toBuffer(toDocx(plan, new Map(), lib, Lexer, 'book', { profile }).document));
  const xml = await zip.file('word/document.xml').async('string'), styles = await zip.file('word/styles.xml').async('string');
  assert.match(xml, /<w:pgSz w:w="11906" w:h="16838"/);
  assert.match(xml, /<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/);
  assert.doesNotMatch(xml, /<w:footerReference/, 'no page numbers');
  assert.match(styles, /<w:docDefaults>[\s\S]*w:ascii="Cambria"[\s\S]*<w:sz w:val="24"\/>[\s\S]*w:line="480"/);
});

test('paper: Word is told not to hyphenate the references and table text, which docx cannot write', async () => {
  const plan = exportPlan({ title: 'T', nodes: [
    { id: 'h', kind: 'Chapter', text: '1 Intro' }, { id: 'a', kind: 'Paragraph', text: 'Hello.' },
    { id: 't', kind: 'Table', text: '' }, { id: 'r', kind: 'Row', text: '' }, { id: 'c', kind: 'Cell', text: 'x' },
    { id: 'rh', kind: 'Chapter', text: 'References' }, { id: 'b', kind: 'Paragraph', text: '[1] A.' },
  ] });
  const built = toDocx(plan, new Map(), lib, Lexer, 'paper');
  assert.deepEqual(built.unhyphenated, ['References', 'TableText']);
  const styles = await (await lib.JSZip.loadAsync(await packDocx(built, lib, 'nodebuffer'))).file('word/styles.xml').async('string');
  for (const id of ['References', 'TableText']) {
    const style = styles.split(`w:styleId="${id}"`)[1].split('</w:style>')[0];
    // In the schema's order: before the spacing, indent and alignment that follow it.
    assert.match(style, /<w:pPr><w:suppressAutoHyphens\/>(<w:spacing|<w:ind|<w:jc)/, id);
  }
  const book = toDocx(plan, new Map(), lib, Lexer, 'book');
  assert.deepEqual(book.unhyphenated, []);
});

test('table columns as Word and a browser size them: the longest word at least, the rest by the longest cell', () => {
  // Two short columns and a long one in 241.35 points of 9-point type, 5 points either side.
  const shares = tableColumns([['Suite', 'Tests', 'What it exercises'], ['Engine', '1,397', 'Storage, typed operations, revisions, proposals and the semantic compiler']], ARTICLE.column / 9, 10 / 9);
  assert.equal(Math.round(shares.reduce((a, b) => a + b) * 1e6), 1e6);
  assert.ok(shares[2] > 0.5 && shares[0] > shares[1], JSON.stringify(shares));
  // When everything fits, each column takes its longest cell's share.
  const small = tableColumns([['aa', 'aaaa']], 100, 0);
  assert.ok(Math.abs(small[1] - 2 * small[0]) < 1e-9, JSON.stringify(small));
});

test('paper as typeset: TeX\'s lines, each ending in a break, the spaces widened to fill it, the references balanced as revtex balances them', async () => {
  const long = 'Typesetting a paragraph well means choosing all of its breaks at once. A line that is a little loose early on can make room for a better line later, and the cost of each line depends on how far its spaces must stretch or shrink.';
  const paper = { title: 'A Paper', nodes: [
    { id: 'h1', kind: 'Chapter', text: '1 Introduction' },
    { id: 'c', kind: 'Paragraph', text: long },
    { id: 'h2', kind: 'Chapter', text: 'References' },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, kind: 'Paragraph', text: `[${i + 1}] Someone Else and Another Person. 2020. A Work with a Title Long Enough to Take Two Lines. Its Publisher.` })),
  ] };
  const plan = exportPlan(paper);
  const words = async options => {
    const { document } = toDocx(plan, new Map(), lib, Lexer, 'paper', { date: new Date(2026, 9, 16), ...options });
    return (await lib.JSZip.loadAsync(await lib.Packer.toBuffer(document))).file('word/document.xml').async('string');
  };
  const xml = await words({ typeset: true, referencesOnNewPage: true }), flowing = await words({ referencesOnNewPage: true });
  const own = xml.split('<w:p>').find(p => p.includes('Typesetting'));
  // The lines TeX sets the paragraph in, as typeset.mjs finds them, each but the last ending in a break.
  const size = ARTICLE.size, sp = timesWidth(' ', { size });
  const lines = setLines([{ text: softHyphens(long, hyphenate), style: { size } }], { measure: termesWidth, space: { width: sp, stretch: sp / 2, shrink: sp / 3, extra: sp / 3 },
    widths: n => n === 0 ? ARTICLE.column - ARTICLE.indent : ARTICLE.column });
  assert.ok(lines.length >= 3);
  const drawn = own.split('<w:br/>').map(part => [...part.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''));
  assert.deepEqual(drawn.map(s => s.replace(/\s+/g, ' ').trim()), lines.map(l => l.parts.map(p => p.space === undefined ? p.text : ' ').join('') + (l.hyphen ? '-' : '')), 'the paragraph is TeX\'s lines');
  assert.match(own, /<w:jc w:val="left"\/>/, 'Word does not justify the lines again');
  assert.match(own, /<w:spacing w:val="\d+"\/>/, 'its spaces are widened by character spacing');
  assert.doesNotMatch(flowing.split('<w:p>').find(p => p.includes('Typesetting')), /<w:br\/>/, 'the paper layout itself still flows');
  // The references start a page, unbalanced above, and their second column starts where revtex's would.
  assert.match(xml, /<w:type w:val="nextPage"\/>/);
  assert.doesNotMatch(flowing, /<w:type w:val="nextPage"\/>/, 'only the typeset paper follows the reference\'s page');
  const entries = xml.split('<w:p>').filter(p => p.includes('Publisher.'));
  assert.equal(entries.findIndex(p => p.includes('<w:br w:type="column"/>')), 3, 'six two-line entries balance three and three');
});
